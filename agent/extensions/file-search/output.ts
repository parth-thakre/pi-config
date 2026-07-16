import { mkdtemp, open, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";

const STDERR_MAX_BYTES = 8 * 1024;
const STDERR_MAX_LINES = 40;
const STREAM_PREVIEW_ROLLING_BYTES = DEFAULT_MAX_BYTES + 4 * 1024;

export interface TruncationMetadata {
  readonly truncatedBy: "lines" | "bytes";
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
}

export interface FormattedOutput {
  readonly text: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly truncation?: TruncationMetadata;
  readonly fullOutputPath?: string;
}

export interface FormatOutputOptions {
  readonly tempPrefix: "pi-fd-" | "pi-rg-";
  readonly persistFullOutput?: (output: string) => Promise<string>;
}

/** Normalize Windows output and remove terminators that would create phantom lines. */
export function normalizeSearchOutput(output: string) {
  return output.replaceAll("\r\n", "\n").replace(/\n+$/, "");
}

async function persistPrivateOutput(prefix: string, output: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, "output.txt");
  await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
  return path;
}

function metadata(result: TruncationResult): TruncationMetadata | undefined {
  if (!result.truncated || result.truncatedBy === null) return undefined;
  return {
    truncatedBy: result.truncatedBy,
    totalLines: result.totalLines,
    totalBytes: result.totalBytes,
    outputLines: result.outputLines,
    outputBytes: result.outputBytes,
  };
}

/** Apply Pi's standard 50KB/2,000-line head truncation. */
export async function formatSearchOutput(
  rawOutput: string,
  options: FormatOutputOptions,
): Promise<FormattedOutput> {
  const output = normalizeSearchOutput(rawOutput);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const base = {
    lineCount: truncation.totalLines,
    byteCount: truncation.totalBytes,
  };

  if (!truncation.truncated) {
    return { text: output, ...base, truncated: false };
  }

  const persist =
    options.persistFullOutput ??
    ((full: string) => persistPrivateOutput(options.tempPrefix, full));
  const fullOutputPath = await persist(output);
  const text =
    `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;

  return {
    text,
    ...base,
    truncated: true,
    truncation: metadata(truncation),
    fullOutputPath,
  };
}

/** Keep process failures useful without allowing unbounded or active terminal text. */
export function boundedStderr(rawStderr: string) {
  const stderr = sanitizeTerminalText(normalizeSearchOutput(rawStderr)).trim();
  if (!stderr) return "";
  const truncation = truncateHead(stderr, {
    maxBytes: STDERR_MAX_BYTES,
    maxLines: STDERR_MAX_LINES,
  });
  if (!truncation.truncated) return truncation.content;
  const visible =
    truncation.content || "[first stderr line exceeds display limit]";
  return `${visible}\n[stderr truncated: ${truncation.outputLines} of ${truncation.totalLines} lines]`;
}

export function searchFailureMessage(
  tool: "fd" | "rg",
  code: number,
  stderr: string,
) {
  const detail = boundedStderr(stderr) || `exit code ${code}`;
  return `${tool} failed (exit ${code}): ${detail}`;
}

function utf8Head(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/** Incremental normalized stdout capture with a bounded head and private spill. */
export class StreamingSearchCapture {
  private readonly prefix: "pi-fd-" | "pi-rg-";
  private readonly decoder = new TextDecoder();
  private preview = "";
  private pendingCr = false;
  private pendingNewlines = 0;
  private file?: FileHandle;
  private artifactPath?: string;
  private truncated = false;
  private finished = false;
  private totalNewlines = 0;
  private hasContent = false;
  private totalBytes = 0;

  constructor(prefix: "pi-fd-" | "pi-rg-") {
    this.prefix = prefix;
  }

  async append(chunk: Buffer) {
    if (this.finished) throw new Error("search capture is already finished");
    await this.appendDecoded(this.decoder.decode(chunk, { stream: true }));
  }

  private async appendDecoded(decoded: string) {
    let text = this.pendingCr ? `\r${decoded}` : decoded;
    this.pendingCr = text.endsWith("\r");
    if (this.pendingCr) text = text.slice(0, -1);
    text = text.replaceAll("\r\n", "\n");
    if (!text) return;

    const trailing = text.match(/\n+$/u)?.[0].length ?? 0;
    const body = trailing > 0 ? text.slice(0, -trailing) : text;
    if (body) {
      while (this.pendingNewlines > 0) {
        const count = Math.min(this.pendingNewlines, 8 * 1024);
        await this.writeCanonical("\n".repeat(count));
        this.pendingNewlines -= count;
      }
      await this.writeCanonical(body);
    }
    this.pendingNewlines += trailing;
  }

  private async ensureArtifact() {
    if (this.file) return;
    const directory = await mkdtemp(join(tmpdir(), this.prefix));
    this.artifactPath = join(directory, "output.txt");
    this.file = await open(this.artifactPath, "w", 0o600);
  }

  private async writeCanonical(text: string) {
    if (!text) return;
    const bytes = Buffer.byteLength(text, "utf8");
    const newlines = text.split("\n").length - 1;
    const nextBytes = this.totalBytes + bytes;
    const nextNewlines = this.totalNewlines + newlines;
    const nextLines = nextNewlines + 1;
    const crossesLimit =
      nextBytes > DEFAULT_MAX_BYTES || nextLines > DEFAULT_MAX_LINES;

    if (!this.truncated && crossesLimit) {
      await this.ensureArtifact();
      if (this.preview) await this.file!.write(this.preview);
      this.truncated = true;
    }
    if (this.truncated) await this.file!.write(text);

    const remaining = Math.max(
      0,
      STREAM_PREVIEW_ROLLING_BYTES - Buffer.byteLength(this.preview, "utf8"),
    );
    if (remaining > 0) this.preview += utf8Head(text, remaining);
    this.totalBytes = nextBytes;
    this.totalNewlines = nextNewlines;
    this.hasContent = true;
  }

  async finish(): Promise<FormattedOutput> {
    if (!this.finished) {
      await this.appendDecoded(this.decoder.decode());
      if (this.pendingCr) await this.writeCanonical("\r");
      this.finished = true;
      await this.file?.close();
      this.file = undefined;
    }

    const lineCount = this.hasContent ? this.totalNewlines + 1 : 0;
    const truncation = truncateHead(this.preview, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    if (!this.truncated) {
      return {
        text: this.preview,
        lineCount,
        byteCount: this.totalBytes,
        truncated: false,
      };
    }

    const truncatedBy =
      truncation.truncatedBy ??
      (lineCount > DEFAULT_MAX_LINES ? "lines" : "bytes");
    const metadata: TruncationMetadata = {
      truncatedBy,
      totalLines: lineCount,
      totalBytes: this.totalBytes,
      outputLines: truncation.outputLines,
      outputBytes: truncation.outputBytes,
    };
    return {
      text:
        `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${lineCount} lines ` +
        `(${formatSize(truncation.outputBytes)} of ${formatSize(this.totalBytes)}). ` +
        `Full output saved to: ${this.artifactPath}]`,
      lineCount,
      byteCount: this.totalBytes,
      truncated: true,
      truncation: metadata,
      fullOutputPath: this.artifactPath,
    };
  }
}

/** Small incremental stderr head; excess bytes are discarded while draining. */
export class BoundedStderrCapture {
  private readonly decoder = new TextDecoder();
  private text = "";

  append(chunk: Buffer) {
    const decoded = this.decoder.decode(chunk, { stream: true });
    const remaining = Math.max(
      0,
      STDERR_MAX_BYTES * 2 - Buffer.byteLength(this.text, "utf8"),
    );
    if (remaining > 0) this.text += utf8Head(decoded, remaining);
  }

  finish() {
    this.text += this.decoder.decode();
    return boundedStderr(this.text);
  }
}
