const DEFAULT_CONCURRENCY = 4;
export const MAX_AGENT_CALLS = 32;
export const RUN_SHUTDOWN_TIMEOUT_MS = 8_000;
export type AgentAccess = "read" | "write";

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted");
}

interface Waiter {
  access: AgentAccess;
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/** Fair writer-exclusive lock: readers fan out, writers run completely alone. */
class AgentScheduler {
  private readers = 0;
  private writer = false;
  private readonly queue: Waiter[] = [];
  private readonly readerLimit: number;

  constructor(readerLimit: number) {
    this.readerLimit = readerLimit;
  }

  acquire(access: AgentAccess, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.canStartImmediately(access)) {
      this.start(access);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        access,
        resolve: () => {},
        reject,
        signal,
        onAbort: () => {},
      };
      waiter.resolve = () => {
        signal.removeEventListener("abort", waiter.onAbort);
        this.start(access);
        resolve();
      };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      this.queue.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  release(access: AgentAccess) {
    if (access === "write") this.writer = false;
    else this.readers = Math.max(0, this.readers - 1);
    this.drain();
  }

  clear() {
    const queued = this.queue.splice(0);
    for (const waiter of queued) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError(waiter.signal));
    }
  }

  private canStartImmediately(access: AgentAccess) {
    if (this.queue.length > 0 || this.writer) return false;
    return access === "write"
      ? this.readers === 0
      : this.readers < this.readerLimit;
  }

  private start(access: AgentAccess) {
    if (access === "write") this.writer = true;
    else this.readers++;
  }

  private drain() {
    while (this.queue.length > 0) {
      const first = this.queue[0]!;
      if (first.signal.aborted) {
        this.queue.shift();
        first.signal.removeEventListener("abort", first.onAbort);
        first.reject(abortError(first.signal));
        continue;
      }
      if (this.writer) return;
      if (first.access === "write") {
        if (this.readers > 0) return;
        this.queue.shift();
        first.resolve();
        return;
      }
      if (this.readers >= this.readerLimit) return;
      this.queue.shift();
      first.resolve();
      // Continue only across the contiguous reader group. A queued writer is
      // never bypassed by newer readers.
    }
  }
}

/** Owns every agent task and the run-wide fanout/abort budget. */
export class RunController {
  private readonly abortController = new AbortController();
  private readonly scheduler: AgentScheduler;
  private readonly tasks = new Set<Promise<unknown>>();
  private callCount = 0;
  private sealed = false;
  private parentAbort?: () => void;
  private parentSignal?: AbortSignal;

  constructor(parentSignal?: AbortSignal, concurrency = DEFAULT_CONCURRENCY) {
    this.scheduler = new AgentScheduler(
      Math.max(1, Math.min(DEFAULT_CONCURRENCY, Math.floor(concurrency))),
    );
    if (parentSignal) {
      this.parentSignal = parentSignal;
      this.parentAbort = () => this.abort("Parent operation was aborted");
      if (parentSignal.aborted) this.parentAbort();
      else parentSignal.addEventListener("abort", this.parentAbort, { once: true });
    }
  }

  get signal() {
    return this.abortController.signal;
  }

  get calls() {
    return this.callCount;
  }

  schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    invocationSignal?: AbortSignal,
    access: AgentAccess = "write",
  ): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
    if (this.signal.aborted) return Promise.reject(abortError(this.signal));
    if (this.callCount >= MAX_AGENT_CALLS) {
      return Promise.reject(
        new Error(`Workflow exceeded the limit of ${MAX_AGENT_CALLS} agent calls`),
      );
    }
    this.callCount++;

    const running = (async () => {
      const taskAbort = new AbortController();
      const onRunAbort = () => taskAbort.abort(this.signal.reason);
      const onInvocationAbort = () => taskAbort.abort(invocationSignal?.reason);
      this.signal.addEventListener("abort", onRunAbort, { once: true });
      invocationSignal?.addEventListener("abort", onInvocationAbort, { once: true });
      if (this.signal.aborted) onRunAbort();
      else if (invocationSignal?.aborted) onInvocationAbort();

      let acquired = false;
      try {
        await this.scheduler.acquire(access, taskAbort.signal);
        acquired = true;
        if (taskAbort.signal.aborted) throw abortError(taskAbort.signal);
        const result = await task(taskAbort.signal);
        if (invocationSignal?.aborted) throw abortError(invocationSignal);
        return result;
      } finally {
        this.signal.removeEventListener("abort", onRunAbort);
        invocationSignal?.removeEventListener("abort", onInvocationAbort);
        if (acquired) this.scheduler.release(access);
      }
    })();
    this.tasks.add(running);
    void running.finally(() => this.tasks.delete(running)).catch(() => {});
    return running;
  }

  abort(reason = "Workflow was aborted") {
    if (!this.signal.aborted) this.abortController.abort(new Error(reason));
    this.scheduler.clear();
  }

  /** Seal the task registry and wait a bounded time for every task to settle. */
  async settle(options: { abort?: boolean; timeoutMs?: number } = {}) {
    this.sealed = true;
    if (options.abort) this.abort();
    const tasks = [...this.tasks];
    if (tasks.length === 0) {
      this.detachParent();
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        options.timeoutMs ?? RUN_SHUTDOWN_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    const settled = Promise.allSettled(tasks).then(() => true as const);
    const completed = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    this.detachParent();
    return completed;
  }

  private detachParent() {
    if (this.parentAbort) {
      this.parentSignal?.removeEventListener("abort", this.parentAbort);
    }
    this.parentAbort = undefined;
    this.parentSignal = undefined;
  }
}
