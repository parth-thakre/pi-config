import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { persistWorkflowJson } from "./artifacts.ts";
import {
  WorkflowJobRegistry,
  createCompletionDelivery,
  markWorkflowJobRegistered,
  markWorkflowJobUnregistered,
  recoverInterruptedWorkflowJobs,
  resolveWorkflowBackgroundMode,
} from "./jobs.ts";
import type { WorkflowDetails } from "./model.ts";

function record(runId = "wf_fixture"): WorkflowDetails {
  return {
    runId,
    sessionId: "session_fixture",
    background: true,
    status: "running",
    lifecycle: "running",
    startedAt: 1,
    repoRoot: "C:/repo",
    commonGitDir: "C:/repo/.git",
    baseCommit: "a".repeat(40),
    branch: `pi/workflow/${runId}`,
    worktreePath: `C:/wt/${runId}`,
    phases: [],
    agents: [],
  };
}

test("TUI defaults background while headless execution is explicitly blocking", () => {
  assert.equal(resolveWorkflowBackgroundMode("tui"), true);
  assert.equal(resolveWorkflowBackgroundMode("tui", false), false);
  for (const mode of ["rpc", "json", "print"] as const) {
    assert.equal(resolveWorkflowBackgroundMode(mode), false);
    assert.throws(
      () => resolveWorkflowBackgroundMode(mode, true),
      /unavailable outside the TUI/,
    );
  }
});

test("startup recovery durably interrupts orphaned running jobs", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-workflow-jobs-"));
  try {
    const details = record();
    persistWorkflowJson(path.join(base, details.runId), details);
    const recovered = recoverInterruptedWorkflowJobs(base, {
      sessionId: details.sessionId,
      now: 42,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "aborted");
    assert.equal(recovered[0]?.lifecycle, "interrupted");
    const stored = JSON.parse(
      readFileSync(path.join(base, details.runId, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.lifecycle, "interrupted");
    assert.equal(stored.worktreePath, details.worktreePath);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recovery does not interrupt a record still owned by a live process", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-workflow-live-job-"));
  try {
    const details = { ...record("wf_live"), ownerPid: 1234 };
    persistWorkflowJson(path.join(base, details.runId), details);
    assert.equal(
      recoverInterruptedWorkflowJobs(base, { isProcessAlive: () => true })
        .length,
      0,
    );
    const stored = JSON.parse(
      readFileSync(path.join(base, details.runId, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.status, "running");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("same-process recovery distinguishes registered jobs from orphan records", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-workflow-same-process-"));
  const orphan = { ...record("wf_orphan"), ownerPid: process.pid };
  const registered = { ...record("wf_registered"), ownerPid: process.pid };
  try {
    persistWorkflowJson(path.join(base, orphan.runId), orphan);
    persistWorkflowJson(path.join(base, registered.runId), registered);
    markWorkflowJobRegistered(registered.runId);
    const recovered = recoverInterruptedWorkflowJobs(base, {
      currentPid: process.pid,
    });
    assert.deepEqual(
      recovered.map((item) => item.runId),
      [orphan.runId],
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(base, registered.runId, "workflow.json"),
          "utf8",
        ),
      ).status,
      "running",
    );
  } finally {
    markWorkflowJobUnregistered(registered.runId);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cancel is idempotent for settled/unknown ids and shutdown owns live jobs", async () => {
  const registry = new WorkflowJobRegistry();
  let aborts = 0;
  registry.add({
    details: record(),
    abort: () => aborts++,
    completion: Promise.resolve(),
  });
  assert.equal(registry.cancel("missing"), false);
  assert.equal(registry.cancel("wf_fixture"), true);
  assert.equal(aborts, 1);
  registry.delete("wf_fixture");
  assert.equal(registry.cancel("wf_fixture"), false);
  await registry.shutdown();
});

test("completion delivery is exactly once", () => {
  let deliveries = 0;
  const deliver = createCompletionDelivery(() => deliveries++);
  assert.equal(deliver(), true);
  assert.equal(deliver(), false);
  assert.equal(deliveries, 1);
});
