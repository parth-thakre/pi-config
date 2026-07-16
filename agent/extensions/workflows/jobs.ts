import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { WorkflowDetails } from "./model.ts";
import { persistWorkflowJson } from "./artifacts.ts";

export const WORKFLOW_COMPLETION_MESSAGE_TYPE = "workflow-completion";

const PROCESS_REGISTRY_KEY = Symbol.for("pi.workflows.registered-runs");
const processRegistry = (() => {
  const root = globalThis as typeof globalThis & {
    [PROCESS_REGISTRY_KEY]?: Set<string>;
  };
  return (root[PROCESS_REGISTRY_KEY] ??= new Set<string>());
})();

export function markWorkflowJobRegistered(runId: string) {
  processRegistry.add(runId);
}

export function markWorkflowJobUnregistered(runId: string) {
  processRegistry.delete(runId);
}

export function registeredWorkflowRunIds(): ReadonlySet<string> {
  return processRegistry;
}

export function resolveWorkflowBackgroundMode(
  mode: "tui" | "rpc" | "json" | "print",
  requested?: boolean,
) {
  if (mode !== "tui") {
    if (requested === true) {
      throw new Error(
        "Background workflows are unavailable outside the TUI because there is no durable worker",
      );
    }
    return false;
  }
  return requested ?? true;
}

export interface ActiveWorkflowJob {
  details: WorkflowDetails;
  abort(reason?: string): void;
  completion?: Promise<void>;
}

export function workflowRunDir(baseDir: string, runId: string) {
  return path.join(baseDir, runId);
}

export function readWorkflowRecord(baseDir: string, runId: string) {
  try {
    return JSON.parse(
      readFileSync(path.join(baseDir, runId, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
  } catch {
    return undefined;
  }
}

export function listWorkflowRecords(baseDir: string, sessionId?: string) {
  let ids: string[] = [];
  try {
    ids = readdirSync(baseDir).filter((name) => name.startsWith("wf_"));
  } catch {
    return [];
  }
  return ids
    .map((id) => readWorkflowRecord(baseDir, id))
    .filter((record): record is WorkflowDetails => Boolean(record))
    .filter((record) => !sessionId || record.sessionId === sessionId)
    .sort((left, right) => right.startedAt - left.startedAt);
}

/** Persistently mark records left running by a dead Pi process as interrupted. */
function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function recoverInterruptedWorkflowJobs(
  baseDir: string,
  options: {
    sessionId?: string;
    now?: number;
    currentPid?: number;
    registeredRunIds?: ReadonlySet<string>;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
) {
  const recovered: WorkflowDetails[] = [];
  for (const details of listWorkflowRecords(baseDir, options.sessionId)) {
    if (details.status !== "running") continue;
    const currentPid = options.currentPid ?? process.pid;
    const registered = options.registeredRunIds ?? processRegistry;
    const ownedByThisProcess = details.ownerPid === currentPid;
    if (
      details.lifecycle !== "interrupted" &&
      details.ownerPid !== undefined &&
      ((!ownedByThisProcess &&
        (options.isProcessAlive ?? processIsAlive)(details.ownerPid)) ||
        (ownedByThisProcess && registered.has(details.runId)))
    ) {
      continue;
    }
    details.status = "aborted";
    details.lifecycle = "interrupted";
    details.finishedAt = options.now ?? Date.now();
    details.error = details.error ?? "Workflow owner session ended before the job settled";
    for (const agent of details.agents) {
      if (agent.state !== "running") continue;
      agent.state = "error";
      agent.finishedAt = details.finishedAt;
      agent.error = agent.error ?? "Interrupted before the agent settled";
    }
    persistWorkflowJson(workflowRunDir(baseDir, details.runId), details);
    recovered.push(details);
  }
  return recovered;
}

/** Session-owned in-memory handles; durable records remain authoritative. */
export class WorkflowJobRegistry {
  private readonly active = new Map<string, ActiveWorkflowJob>();

  add(job: ActiveWorkflowJob) {
    if (this.active.has(job.details.runId)) {
      throw new Error(`Workflow job already exists: ${job.details.runId}`);
    }
    this.active.set(job.details.runId, job);
  }

  get(runId: string) {
    return this.active.get(runId);
  }

  list() {
    return [...this.active.values()];
  }

  delete(runId: string) {
    return this.active.delete(runId);
  }

  cancel(runId: string, reason = "Workflow cancelled") {
    const job = this.active.get(runId);
    if (!job) return false;
    job.abort(reason);
    return true;
  }

  async shutdown(reason = "Pi session is shutting down") {
    const jobs = this.list();
    for (const job of jobs) job.abort(reason);
    await Promise.allSettled(
      jobs
        .map((job) => job.completion)
        .filter((value): value is Promise<void> => Boolean(value)),
    );
  }
}

/** Exactly-once guard for completion delivery across settle/disposal races. */
export function createCompletionDelivery(deliver: () => void) {
  let delivered = false;
  return () => {
    if (delivered) return false;
    delivered = true;
    deliver();
    return true;
  };
}
