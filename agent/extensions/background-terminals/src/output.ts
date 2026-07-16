import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { OutputView } from "./domain.ts";

const DEFAULT_ERROR_LIMIT = 1024;

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    DEFAULT_ERROR_LIMIT,
  );
}

/** Strictly bounded, raw decoded in-memory tail. */
export class OutputBuffer {
  private chunks: string[] = [];
  private retainedBytes = 0;
  private cachedText = "";
  private dirty = false;
  readonly maxRetainedBytes: number;
  totalBytes = 0;
  truncatedBytes = 0;
  version = 0;

  constructor(maxRetainedBytes: number) {
    this.maxRetainedBytes = Math.max(0, maxRetainedBytes);
  }

  push(chunk: string): void {
    if (!chunk) return;
    const source = Buffer.from(chunk, "utf8");
    this.totalBytes += source.length;
    this.version++;

    if (this.maxRetainedBytes === 0) {
      this.truncatedBytes += source.length;
      this.chunks = [];
      this.retainedBytes = 0;
      this.dirty = true;
      return;
    }

    let retained = chunk;
    let retainedLength = source.length;
    if (retainedLength > this.maxRetainedBytes) {
      this.truncatedBytes += this.retainedBytes;
      this.chunks = [];
      this.retainedBytes = 0;
      let start = retainedLength - this.maxRetainedBytes;
      while (start < source.length && (source[start]! & 0xc0) === 0x80) start++;
      retained = source.subarray(start).toString("utf8");
      retainedLength = Buffer.byteLength(retained, "utf8");
      this.truncatedBytes += source.length - retainedLength;
    }

    this.chunks.push(retained);
    this.retainedBytes += retainedLength;
    while (this.retainedBytes > this.maxRetainedBytes) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const firstBuffer = Buffer.from(first, "utf8");
      const excess = this.retainedBytes - this.maxRetainedBytes;
      if (firstBuffer.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= firstBuffer.length;
        this.truncatedBytes += firstBuffer.length;
        continue;
      }

      // Trim only the necessary prefix. If the byte boundary lands inside a
      // UTF-8 continuation sequence, advance to the next complete code point.
      let start = excess;
      while (
        start < firstBuffer.length &&
        (firstBuffer[start]! & 0xc0) === 0x80
      ) {
        start++;
      }
      this.chunks[0] = firstBuffer.subarray(start).toString("utf8");
      this.retainedBytes -= start;
      this.truncatedBytes += start;
    }
    this.dirty = true;
  }

  text(): string {
    if (this.dirty) {
      this.cachedText = this.chunks.join("");
      this.dirty = false;
    }
    return this.cachedText;
  }
}

export interface RotatingSpillOptions {
  directory: string;
  stem: string;
  segmentBytes: number;
  maxFiles: number;
  highWaterMark?: number;
  createWriteStream?: typeof fs.createWriteStream;
}

interface PendingWrite {
  buffer: Buffer;
  offset: number;
  source: Readable;
}

interface Segment {
  path: string;
  bytes: number;
}

/**
 * Bounded rotating disk spill. Backpressure is coupled to the readable that
 * produced the blocked write: write(false) pauses it, and drain resumes it.
 */
export class RotatingSpill {
  private readonly directory: string;
  private readonly stem: string;
  private readonly segmentBytes: number;
  private readonly maxFiles: number;
  private readonly highWaterMark?: number;
  private readonly createWriteStream: typeof fs.createWriteStream;
  private readonly queue: PendingWrite[] = [];
  private readonly paused = new Set<Readable>();
  private readonly idleWaiters = new Set<() => void>();
  private segments: Segment[] = [];
  private stream?: fs.WriteStream;
  private generation = 0;
  private busy = false;
  private closing = false;
  private broken = false;
  private errorText?: string;
  private droppedBytes = 0;
  private rotations = 0;

  constructor(options: RotatingSpillOptions) {
    this.directory = options.directory;
    this.stem = options.stem;
    this.segmentBytes = Math.max(1, options.segmentBytes);
    this.maxFiles = Math.max(1, options.maxFiles);
    this.highWaterMark = options.highWaterMark;
    this.createWriteStream = options.createWriteStream ?? fs.createWriteStream;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  write(chunk: string, source: Readable): void {
    if (!chunk || this.closing || this.broken) return;
    this.queue.push({ buffer: Buffer.from(chunk, "utf8"), offset: 0, source });
    this.pump();
  }

  private pause(source: Readable): void {
    if (this.paused.has(source)) return;
    this.paused.add(source);
    source.pause();
  }

  private resumePaused(): void {
    if (this.busy || this.queue.length > 0) return;
    for (const source of this.paused) source.resume();
    this.paused.clear();
  }

  private notifyIdle(): void {
    if (this.busy || this.queue.length > 0) return;
    this.resumePaused();
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private markBroken(error: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.errorText = boundedError(error);
    this.queue.length = 0;
    this.busy = false;
    try {
      this.stream?.destroy();
    } catch {
      // Disposable spill; the retained tail remains available.
    }
    this.notifyIdle();
  }

  private openSegment(): void {
    if (this.segments.length >= this.maxFiles) {
      const oldest = this.segments.shift()!;
      this.droppedBytes += oldest.bytes;
      try {
        fs.rmSync(oldest.path, { force: true });
      } catch (error) {
        this.markBroken(error);
        return;
      }
    }
    const file = path.join(
      this.directory,
      `${this.stem}.${this.generation++}.log`,
    );
    if (this.segments.length > 0 || this.generation > 1) this.rotations++;
    const segment: Segment = { path: file, bytes: 0 };
    this.segments.push(segment);
    try {
      this.stream = this.createWriteStream(file, {
        flags: "w",
        mode: 0o600,
        ...(this.highWaterMark ? { highWaterMark: this.highWaterMark } : {}),
      });
      this.stream.on("error", (error) => this.markBroken(error));
    } catch (error) {
      this.markBroken(error);
    }
  }

  private rotate(source: Readable): void {
    this.pause(source);
    this.busy = true;
    const previous = this.stream;
    this.stream = undefined;
    if (!previous) {
      this.busy = false;
      this.openSegment();
      this.pump();
      return;
    }
    const complete = () => {
      if (!this.busy) return;
      this.busy = false;
      if (!this.broken) this.openSegment();
      this.pump();
    };
    previous.once("error", complete);
    try {
      previous.end(complete);
    } catch (error) {
      this.markBroken(error);
    }
  }

  private pump(): void {
    if (this.busy || this.broken) return this.notifyIdle();
    while (this.queue.length > 0) {
      const pending = this.queue[0]!;
      if (!this.stream) this.openSegment();
      if (!this.stream || this.broken) return this.notifyIdle();
      const segment = this.segments.at(-1)!;
      const remaining = this.segmentBytes - segment.bytes;
      if (remaining <= 0) {
        this.rotate(pending.source);
        return;
      }
      const available = pending.buffer.length - pending.offset;
      const size = Math.min(available, remaining);
      const slice = pending.buffer.subarray(
        pending.offset,
        pending.offset + size,
      );
      pending.offset += size;
      segment.bytes += size;
      const writable = this.stream.write(slice);
      if (pending.offset >= pending.buffer.length) this.queue.shift();
      if (!writable) {
        this.pause(pending.source);
        this.busy = true;
        this.stream.once("drain", () => {
          this.busy = false;
          this.pump();
        });
        return;
      }
      if (segment.bytes >= this.segmentBytes && this.queue.length > 0) {
        this.rotate(this.queue[0]!.source);
        return;
      }
    }
    this.notifyIdle();
  }

  private whenIdle(): Promise<void> {
    if (!this.busy && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async flush(timeoutMs: number): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.whenIdle();
          const stream = this.stream;
          this.stream = undefined;
          if (!stream || this.broken) return;
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            stream.once("error", done);
            try {
              stream.end(done);
            } catch (error) {
              this.markBroken(error);
              resolve();
            }
          });
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(
            () => {
              this.markBroken(`spill flush exceeded ${timeoutMs}ms`);
              resolve();
            },
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.resumePaused();
    }
  }

  removeFiles(): void {
    for (const segment of this.segments) {
      try {
        fs.rmSync(segment.path, { force: true });
      } catch {
        // Session temp retention is best-effort.
      }
    }
    this.segments = [];
  }

  state(): Omit<OutputView, "text" | "totalBytes" | "truncatedBytes"> {
    return {
      spillDirectory: this.directory,
      spillFiles: this.segments.map((segment) => segment.path),
      spillRetainedBytes: this.segments.reduce(
        (sum, segment) => sum + segment.bytes,
        0,
      ),
      spillDroppedBytes: this.droppedBytes,
      spillRotations: this.rotations,
      spillComplete: !this.broken && this.droppedBytes === 0,
      ...(this.errorText ? { spillError: this.errorText } : {}),
    };
  }
}

export class OutputCapture {
  readonly buffer: OutputBuffer;
  readonly spill: RotatingSpill;
  private readonly readable: Readable;
  private readonly onChange: () => void;

  constructor(
    readable: Readable,
    buffer: OutputBuffer,
    spill: RotatingSpill,
    onChange: () => void,
  ) {
    this.readable = readable;
    this.buffer = buffer;
    this.spill = spill;
    this.onChange = onChange;
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      this.buffer.push(chunk);
      this.spill.write(chunk, readable);
      this.onChange();
    });
  }

  async flush(timeoutMs: number): Promise<void> {
    await this.spill.flush(timeoutMs);
  }

  forceClose(): void {
    this.readable.destroy();
  }

  removeSpillFiles(): void {
    this.spill.removeFiles();
  }

  view(): OutputView {
    return {
      text: this.buffer.text(),
      totalBytes: this.buffer.totalBytes,
      truncatedBytes: this.buffer.truncatedBytes,
      ...this.spill.state(),
    };
  }
}
