import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import {
  formatExit,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer, OutputCapture, RotatingSpill } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
export const SPILL_SEGMENT_BYTES = 2 * 1024 * 1024;
export const SPILL_MAX_FILES = 4;

export const POWERSHELL_WRAPPER = String.raw`
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = $null
try {
  $command = [ScriptBlock]::Create($env:PI_BACKGROUND_TERMINAL_COMMAND)
  & $command
  $succeeded = $?
  $nativeExit = $global:LASTEXITCODE
  if (-not $succeeded) { exit 1 }
  if ($null -ne $nativeExit -and [int]$nativeExit -ne 0) { exit [int]$nativeExit }
  exit 0
} catch {
  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())
  exit 1
}
`.trim();

function existingFile(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    return fs.statSync(candidate).isFile()
      ? path.resolve(candidate)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve only PowerShell 7 (`pwsh.exe`), never Windows PowerShell. */
export function resolvePowerShell7(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    env.PI_PWSH_PATH,
    env.ProgramFiles
      ? path.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
      : undefined,
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe")
      : undefined,
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) =>
        path.join(directory.replace(/^"|"$/g, ""), "pwsh.exe"),
      ),
  ];
  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found && path.basename(found).toLowerCase() === "pwsh.exe")
      return found;
  }
  throw new Error(
    "PowerShell 7 was not found. Install pwsh.exe or set PI_PWSH_PATH.",
  );
}

export function resolveTaskkill(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.WINDIR;
  if (!root)
    throw new Error("SystemRoot is not set; cannot resolve taskkill.exe.");
  const candidate = path.join(root, "System32", "taskkill.exe");
  const found = existingFile(candidate);
  if (!found) throw new Error(`taskkill.exe was not found at ${candidate}.`);
  return found;
}

export type TaskkillClassification =
  "terminated" | "not-found" | "failed" | "timed-out";

export interface TaskkillResult {
  readonly force: boolean;
  readonly classification: TaskkillClassification;
  readonly code?: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  readonly wasRunning: boolean;
  readonly killed: boolean;
  readonly exit: string;
  readonly helpers: readonly TaskkillResult[];
}

export interface TerminalReadModel {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestKill(id: string): void;
  setOnSettled(
    hook: ((snapshot: TerminalSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

export interface ManagerOptions {
  readonly pwshPath?: string;
  readonly taskkillPath?: string;
  readonly retainedBytes?: number;
  readonly spillSegmentBytes?: number;
  readonly spillMaxFiles?: number;
  readonly spillHighWaterMark?: number;
  readonly spillRoot?: string;
  readonly gracefulWaitMs?: number;
  readonly forcedWaitMs?: number;
  readonly helperTimeoutMs?: number;
  readonly inheritedPipeGraceMs?: number;
  readonly flushTimeoutMs?: number;
  readonly disposalTimeoutMs?: number;
}

interface MutableSnapshot extends TerminalSnapshot {
  status: TerminalStatus;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  stdout: OutputCapture;
  stderr: OutputCapture;
  exited: boolean;
  closed: boolean;
  processError?: string;
  killDelivered: boolean;
  killTask?: Promise<readonly TaskkillResult[]>;
  settleTask?: Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
  closeObserved: Promise<void>;
  resolveCloseObserved: () => void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function appendError(current: string | undefined, next: string): string {
  const combined = current ? `${current}; ${next}` : next;
  return combined.slice(0, 4096);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return Promise.race([promise, wait(timeoutMs).then(() => undefined)]);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      new Error("Kill wait aborted; termination continues in the background."),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new Error(
          "Kill wait aborted; termination continues in the background.",
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function helperOutput(text: string): string {
  return text.slice(-4096);
}

function classifyTaskkill(
  code: number | null,
  stdout: string,
  stderr: string,
): TaskkillClassification {
  if (code === 0) return "terminated";
  const combined = `${stdout}\n${stderr}`;
  if (/not found|no running instance|cannot find|not running/i.test(combined))
    return "not-found";
  return "failed";
}

export class BackgroundTerminalManager {
  private readonly options: Required<
    Omit<ManagerOptions, "pwshPath" | "taskkillPath" | "spillRoot">
  > & {
    pwshPath: string;
    taskkillPath: string;
    spillRoot: string;
  };
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly idListeners = new Map<string, Set<() => void>>();
  private readonly killInterest = new Map<string, number>();
  private counter = 0;
  private reserved = 0;
  private disposed = false;
  private spillDirectory?: string;
  private onSettled?: (snapshot: TerminalSnapshot, consumed: boolean) => void;

  readonly view: TerminalReadModel;

  constructor(options: ManagerOptions = {}) {
    if (process.platform !== "win32") {
      throw new Error(
        "background-terminals supports native Windows PowerShell 7 only.",
      );
    }
    this.options = {
      pwshPath: options.pwshPath ?? resolvePowerShell7(),
      taskkillPath: options.taskkillPath ?? resolveTaskkill(),
      retainedBytes: options.retainedBytes ?? RETAINED_PER_STREAM,
      spillSegmentBytes: options.spillSegmentBytes ?? SPILL_SEGMENT_BYTES,
      spillMaxFiles: options.spillMaxFiles ?? SPILL_MAX_FILES,
      spillHighWaterMark: options.spillHighWaterMark ?? 64 * 1024,
      spillRoot:
        options.spillRoot ?? path.join(os.tmpdir(), "pi-background-terminals"),
      gracefulWaitMs: options.gracefulWaitMs ?? 750,
      forcedWaitMs: options.forcedWaitMs ?? 750,
      helperTimeoutMs: options.helperTimeoutMs ?? 1_500,
      inheritedPipeGraceMs: options.inheritedPipeGraceMs ?? 1_000,
      flushTimeoutMs: options.flushTimeoutMs ?? 1_500,
      disposalTimeoutMs: options.disposalTimeoutMs ?? 5_000,
    };

    this.view = {
      list: () => [...this.entries.values()].map((entry) => entry.snapshot),
      get: (id) => this.entries.get(id)?.snapshot,
      size: () => this.entries.size,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      subscribeTo: (id, listener) => {
        const set = this.idListeners.get(id) ?? new Set<() => void>();
        set.add(listener);
        this.idListeners.set(id, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) this.idListeners.delete(id);
        };
      },
      requestKill: (id) => {
        const entry = this.entries.get(id);
        if (entry) void this.terminate(entry);
      },
      setOnSettled: (hook) => {
        this.onSettled = hook;
      },
    };
  }

  private notify(id?: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* UI listeners are isolated. */
      }
    }
    if (id) {
      for (const listener of [...(this.idListeners.get(id) ?? [])]) {
        try {
          listener();
        } catch {
          /* UI listeners are isolated. */
        }
      }
    }
  }

  private directory(): string {
    if (this.spillDirectory) return this.spillDirectory;
    fs.mkdirSync(this.options.spillRoot, { recursive: true, mode: 0o700 });
    this.spillDirectory = fs.mkdtempSync(
      path.join(this.options.spillRoot, "session-"),
    );
    return this.spillDirectory;
  }

  private runningCount(): number {
    return [...this.entries.values()].filter(
      (entry) => entry.snapshot.status === "running",
    ).length;
  }

  start(options: StartOptions): TerminalSnapshot {
    if (this.disposed)
      throw new Error("Background terminal manager is shutting down.");
    if (this.runningCount() + this.reserved >= MAX_RUNNING) {
      throw new Error(
        `Max ${MAX_RUNNING} background terminals can run concurrently.`,
      );
    }
    this.reserved++;
    try {
      const id = `bt-${++this.counter}`;
      // All filesystem/capture resources are allocated before spawning. Only
      // stream attachment remains post-spawn, and that window has synchronous
      // process-tree cleanup on every failure.
      const spillDirectory = this.directory();
      const stdoutSpill = new RotatingSpill({
        directory: spillDirectory,
        stem: `${id}.stdout`,
        segmentBytes: this.options.spillSegmentBytes,
        maxFiles: this.options.spillMaxFiles,
        highWaterMark: this.options.spillHighWaterMark,
      });
      const stderrSpill = new RotatingSpill({
        directory: spillDirectory,
        stem: `${id}.stderr`,
        segmentBytes: this.options.spillSegmentBytes,
        maxFiles: this.options.spillMaxFiles,
        highWaterMark: this.options.spillHighWaterMark,
      });
      const stdoutBuffer = new OutputBuffer(this.options.retainedBytes);
      const stderrBuffer = new OutputBuffer(this.options.retainedBytes);
      const settled = deferred();
      const closeObserved = deferred();
      const childOptions: SpawnOptions = {
        cwd: options.cwd,
        env: {
          ...process.env,
          PI_BACKGROUND_TERMINAL_COMMAND: options.command,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      };
      const child = spawn(
        this.options.pwshPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          POWERSHELL_WRAPPER,
        ],
        childOptions,
      );
      let entry!: Entry;
      let stdoutCapture: OutputCapture;
      let stderrCapture: OutputCapture;
      try {
        if (!child.stdout || !child.stderr) {
          throw new Error("PowerShell capture pipes were not created");
        }
        stdoutCapture = new OutputCapture(
          child.stdout,
          stdoutBuffer,
          stdoutSpill,
          () => this.notify(id),
        );
        stderrCapture = new OutputCapture(
          child.stderr,
          stderrBuffer,
          stderrSpill,
          () => this.notify(id),
        );
      } catch (error) {
        try {
          if (child.pid) {
            const killed = spawnSync(
              this.options.taskkillPath,
              ["/PID", String(child.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true, shell: false },
            );
            if (killed.status !== 0) child.kill();
          } else {
            child.kill();
          }
        } catch {
          try {
            child.kill();
          } catch {
            // The setup error remains authoritative.
          }
        }
        stdoutSpill.removeFiles();
        stderrSpill.removeFiles();
        throw error;
      }
      const snapshot: MutableSnapshot = {
        id,
        command: options.command,
        title: options.title,
        cwd: options.cwd,
        pid: child.pid,
        status: "running",
        createdAt: Date.now(),
        get stdout() {
          return stdoutCapture.view();
        },
        get stderr() {
          return stderrCapture.view();
        },
      };
      entry = {
        snapshot,
        child,
        stdout: stdoutCapture,
        stderr: stderrCapture,
        exited: false,
        closed: false,
        killDelivered: false,
        settled: settled.promise,
        resolveSettled: settled.resolve,
        closeObserved: closeObserved.promise,
        resolveCloseObserved: closeObserved.resolve,
      };
      this.entries.set(id, entry);

      child.once("error", (error) => {
        entry.processError =
          error instanceof Error ? error.message : String(error);
        entry.exited = true;
      });
      child.once("exit", (code, signal) => {
        entry.exited = true;
        if (!entry.processError) {
          snapshot.exitCode = code ?? undefined;
          snapshot.signal = signal ?? undefined;
        }
        setTimeout(() => {
          if (snapshot.status === "running" && !entry.closed)
            void this.cleanupInheritedPipes(entry);
        }, this.options.inheritedPipeGraceMs).unref?.();
      });
      child.once("close", (code, signal) => {
        entry.closed = true;
        entry.resolveCloseObserved();
        if (!entry.processError) {
          snapshot.exitCode ??= code ?? undefined;
          snapshot.signal ??= signal ?? undefined;
        }
        void this.settle(entry);
      });
      this.notify(id);
      return snapshot;
    } finally {
      this.reserved--;
    }
  }

  private async cleanupInheritedPipes(entry: Entry): Promise<void> {
    // The root already exited naturally. taskkill may still find its process
    // object/tree; never convert this natural exit into "killed".
    const helpers = await this.runTaskkill(entry.snapshot.pid, true);
    if (helpers.classification !== "terminated") {
      entry.snapshot.errorText = appendError(
        entry.snapshot.errorText,
        "Inherited stdio remained open after the PowerShell process exited; descendant cleanup could not be confirmed",
      );
    }
    await within(entry.closeObserved, this.options.forcedWaitMs);
    if (!entry.closed) {
      entry.stdout.forceClose();
      entry.stderr.forceClose();
      entry.closed = true;
      entry.resolveCloseObserved();
      entry.snapshot.errorText = appendError(
        entry.snapshot.errorText,
        "stdio was closed after a bounded cleanup deadline; output may be incomplete",
      );
      await this.settle(entry);
    }
  }

  private async settle(entry: Entry): Promise<void> {
    if (entry.snapshot.status !== "running") return;
    if (entry.settleTask) return entry.settleTask;
    entry.settleTask = (async () => {
      await Promise.all([
        entry.stdout.flush(this.options.flushTimeoutMs),
        entry.stderr.flush(this.options.flushTimeoutMs),
      ]);
      const stdout = entry.stdout.view();
      const stderr = entry.stderr.view();
      for (const view of [stdout, stderr]) {
        if (view.spillError)
          entry.snapshot.errorText = appendError(
            entry.snapshot.errorText,
            `spill: ${view.spillError}`,
          );
      }
      const snapshot = entry.snapshot;
      snapshot.settledAt = Date.now();
      snapshot.status = entry.killDelivered
        ? "killed"
        : entry.processError || snapshot.exitCode !== 0
          ? "failed"
          : "done";
      if (entry.processError)
        snapshot.errorText = appendError(
          snapshot.errorText,
          entry.processError,
        );
      const consumed = (this.killInterest.get(snapshot.id) ?? 0) > 0;
      entry.resolveSettled();
      this.notify(snapshot.id);
      if (!this.disposed) {
        try {
          this.onSettled?.(snapshot, consumed);
        } catch {
          /* Session may be closing. */
        }
      }
      this.prune();
    })();
    return entry.settleTask;
  }

  private prune(): void {
    if (this.entries.size <= MAX_TRACKED) return;
    const settled = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.snapshot.status !== "running" &&
          !this.killInterest.has(entry.snapshot.id),
      )
      .sort(
        (a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0),
      );
    while (this.entries.size > MAX_TRACKED && settled.length > 0) {
      const entry = settled.shift()!;
      this.entries.delete(entry.snapshot.id);
      entry.stdout.removeSpillFiles();
      entry.stderr.removeSpillFiles();
    }
  }

  private runTaskkill(
    pid: number | undefined,
    force: boolean,
  ): Promise<TaskkillResult> {
    if (!pid)
      return Promise.resolve({
        force,
        classification: "not-found",
        stdout: "",
        stderr: "missing pid",
      });
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const helper = spawn(
        this.options.taskkillPath,
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
      );
      helper.stdout?.setEncoding("utf8");
      helper.stderr?.setEncoding("utf8");
      helper.stdout?.on("data", (chunk: string) => {
        stdout = helperOutput(stdout + chunk);
      });
      helper.stderr?.on("data", (chunk: string) => {
        stderr = helperOutput(stderr + chunk);
      });
      const done = (result: TaskkillResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      helper.once("error", (error) =>
        done({
          force,
          classification: "failed",
          stdout,
          stderr: helperOutput(
            `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
          ),
        }),
      );
      helper.once("close", (code) =>
        done({
          force,
          classification: classifyTaskkill(code, stdout, stderr),
          code: code ?? undefined,
          stdout,
          stderr,
        }),
      );
      timer = setTimeout(() => {
        try {
          helper.kill();
        } catch {
          /* helper deadline is authoritative */
        }
        done({ force, classification: "timed-out", stdout, stderr });
      }, this.options.helperTimeoutMs);
    });
  }

  private terminate(entry: Entry): Promise<readonly TaskkillResult[]> {
    if (entry.killTask) return entry.killTask;
    if (entry.snapshot.status !== "running") return Promise.resolve([]);
    entry.killTask = (async () => {
      const helpers: TaskkillResult[] = [];
      const naturallyExitedBeforeSoft = entry.exited;
      const soft = await this.runTaskkill(entry.snapshot.pid, false);
      helpers.push(soft);
      if (soft.classification === "terminated" && !naturallyExitedBeforeSoft)
        entry.killDelivered = true;
      await within(entry.settled, this.options.gracefulWaitMs);
      if (entry.snapshot.status === "running") {
        const naturallyExitedBeforeForce = entry.exited;
        const forced = await this.runTaskkill(entry.snapshot.pid, true);
        helpers.push(forced);
        if (
          forced.classification === "terminated" &&
          !naturallyExitedBeforeForce
        )
          entry.killDelivered = true;
        await within(entry.settled, this.options.forcedWaitMs);
      }
      if (entry.snapshot.status === "running") {
        try {
          entry.child.kill();
        } catch {
          /* taskkill result remains the truth source */
        }
        entry.stdout.forceClose();
        entry.stderr.forceClose();
        entry.closed = true;
        entry.resolveCloseObserved();
        entry.snapshot.errorText = appendError(
          entry.snapshot.errorText,
          "Process-tree termination reached its bounded deadline; descendant death could not be confirmed",
        );
        await this.settle(entry);
      }
      return helpers;
    })();
    return entry.killTask;
  }

  status(id: string): TerminalSnapshot {
    const snapshot = this.entries.get(id)?.snapshot;
    if (!snapshot)
      throw new Error(
        `Unknown terminal id "${id}". Known: ${[...this.entries.keys()].join(", ") || "none"}.`,
      );
    return snapshot;
  }

  list(): ReadonlyArray<TerminalSnapshot> {
    return this.view.list();
  }

  async kill(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<KillResult>> {
    const unique = [...new Set(ids)];
    const entries = unique.map((id) => {
      const entry = this.entries.get(id);
      if (!entry)
        throw new Error(
          `Unknown terminal id "${id}". Known: ${[...this.entries.keys()].join(", ") || "none"}.`,
        );
      return entry;
    });
    const running = entries.filter(
      (entry) => entry.snapshot.status === "running",
    );
    for (const entry of running)
      this.killInterest.set(
        entry.snapshot.id,
        (this.killInterest.get(entry.snapshot.id) ?? 0) + 1,
      );
    const tasks = new Map(
      running.map((entry) => [entry.snapshot.id, this.terminate(entry)]),
    );
    try {
      const reports = await abortable(
        Promise.all(
          [...tasks.entries()].map(
            async ([id, task]) => [id, await task] as const,
          ),
        ),
        signal,
      );
      const reportById = new Map(reports);
      return entries.map((entry): KillResult => {
        const wasRunning = tasks.has(entry.snapshot.id);
        return {
          id: entry.snapshot.id,
          title: entry.snapshot.title,
          status: entry.snapshot.status,
          wasRunning,
          killed: wasRunning && entry.snapshot.status === "killed",
          exit: formatExit(entry.snapshot),
          helpers: reportById.get(entry.snapshot.id) ?? [],
        };
      });
    } finally {
      for (const entry of running) {
        const count = (this.killInterest.get(entry.snapshot.id) ?? 1) - 1;
        if (count <= 0) this.killInterest.delete(entry.snapshot.id);
        else this.killInterest.set(entry.snapshot.id, count);
      }
      this.prune();
    }
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.entries.values()].filter(
      (entry) => entry.snapshot.status === "running",
    );
    const teardown = Promise.all(running.map((entry) => this.terminate(entry)));
    await within(teardown, this.options.disposalTimeoutMs);
    for (const entry of running) {
      if (entry.snapshot.status === "running") {
        entry.stdout.forceClose();
        entry.stderr.forceClose();
        entry.closed = true;
        entry.resolveCloseObserved();
        await this.settle(entry);
      }
    }
    this.entries.clear();
    if (this.spillDirectory) {
      try {
        fs.rmSync(this.spillDirectory, { recursive: true, force: true });
      } catch {
        /* temp retention is best effort */
      }
      this.spillDirectory = undefined;
    }
    this.notify();
  }
}
