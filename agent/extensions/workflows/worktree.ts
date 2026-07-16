import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import * as path from "node:path";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type GitExec = (
  command: "git",
  argv: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<GitExecResult>;

export interface WorkflowWorktree {
  repoRoot: string;
  commonGitDir: string;
  /** Human-readable source ref; absent only on legacy persisted runs. */
  baseRef?: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
}

export interface WorkflowRepository {
  repoRoot: string;
  commonGitDir: string;
  baseRef: string;
  baseCommit: string;
}

export const DEFAULT_WORKFLOW_BASE = "origin/main";

export interface WorktreeSummary {
  finalHead: string;
  dirtySummary: string;
  dirty: boolean;
}

export interface WorktreeCleanupIdentity {
  currentHead: string;
  branch: string;
  repoRoot: string;
  commonGitDir: string;
  worktreePath: string;
}

function output(result: GitExecResult) {
  return result.stdout.trim();
}

function gitError(argv: readonly string[], result: GitExecResult) {
  const diagnostic = (result.stderr || result.stdout).trim();
  return new Error(
    `git ${argv.join(" ")} failed (exit ${result.code})${diagnostic ? `: ${diagnostic}` : ""}`,
  );
}

async function git(
  exec: GitExec,
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 30_000,
) {
  const result = await exec("git", argv, { cwd, signal, timeout });
  if (result.code !== 0) throw gitError(argv, result);
  return output(result);
}

async function canonical(value: string, cwd?: string) {
  const absolute = path.resolve(cwd ?? process.cwd(), value);
  return realpath(absolute);
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Resolve immutable repository identity and workflow base, then reject a dirty
 * launching checkout. The default is freshly fetched origin/main; an explicit
 * base resolves locally unless it names origin/<branch>. Every Git invocation
 * is argv-based; this module never invokes a shell.
 */
export async function preflightWorkflowRepository(options: {
  exec: GitExec;
  cwd: string;
  base?: string;
  signal?: AbortSignal;
}): Promise<WorkflowRepository> {
  const repoText = await git(
    options.exec,
    ["rev-parse", "--show-toplevel"],
    options.cwd,
    options.signal,
  ).catch((error) => {
    throw new Error(
      `Workflows require a Git repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const repoRoot = await canonical(repoText, options.cwd);
  const commonText = await git(
    options.exec,
    ["rev-parse", "--git-common-dir"],
    repoRoot,
    options.signal,
  );
  const commonGitDir = await canonical(commonText, repoRoot);

  const baseRef = options.base?.trim() || DEFAULT_WORKFLOW_BASE;
  if (
    baseRef.length > 512 ||
    /[\0-\x1f\x7f]/.test(baseRef) ||
    baseRef.startsWith("-")
  ) {
    throw new Error(`Invalid workflow base ref: ${JSON.stringify(baseRef)}`);
  }

  let baseCommit: string;
  if (baseRef.startsWith("origin/")) {
    const remoteBranch = baseRef.slice("origin/".length);
    if (!remoteBranch)
      throw new Error("Workflow base origin/ requires a branch name");
    await git(
      options.exec,
      ["check-ref-format", `refs/heads/${remoteBranch}`],
      repoRoot,
      options.signal,
    ).catch(() => {
      throw new Error(`Invalid origin branch for workflow base: ${baseRef}`);
    });

    // Fetch into a run-private ref. Resolving a shared origin/<branch> in a
    // second command would allow another concurrent fetch/update-ref to swap
    // the commit between fetch and snapshot.
    const snapshotRef = `refs/pi/workflow-base/${randomBytes(12).toString("hex")}`;
    try {
      await git(
        options.exec,
        [
          "fetch",
          "--no-tags",
          "origin",
          `+refs/heads/${remoteBranch}:${snapshotRef}`,
        ],
        repoRoot,
        options.signal,
        120_000,
      ).catch((error) => {
        throw new Error(
          `Unable to fetch workflow base ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      baseCommit = await git(
        options.exec,
        [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${snapshotRef}^{commit}`,
        ],
        repoRoot,
        options.signal,
      );
    } finally {
      try {
        await options.exec("git", ["update-ref", "-d", snapshotRef], {
          cwd: repoRoot,
          timeout: 30_000,
        });
      } catch {
        // The immutable commit is already captured. A stale private ref is
        // harmless and must not mask the fetch/resolve result.
      }
    }
  } else {
    baseCommit = await git(
      options.exec,
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      repoRoot,
      options.signal,
    ).catch((error) => {
      throw new Error(
        `Unable to resolve workflow base ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
    throw new Error(
      `Git returned an invalid base commit for ${baseRef}: ${baseCommit}`,
    );
  }
  const dirty = await git(
    options.exec,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
    options.signal,
  );
  if (dirty) {
    throw new Error(
      `Parent checkout is dirty; commit or clean it before launching a workflow. No stash or reset was performed.\n${dirty}`,
    );
  }
  return { repoRoot, commonGitDir, baseRef, baseCommit };
}

/** Create exactly one locked, new-branch worktree and validate its identity. */
export async function createWorkflowWorktree(options: {
  exec: GitExec;
  cwd: string;
  runId: string;
  worktreeBaseDir: string;
  base?: string;
  signal?: AbortSignal;
  repository?: WorkflowRepository;
}): Promise<WorkflowWorktree> {
  if (!/^[A-Za-z0-9_-]+$/.test(options.runId)) {
    throw new Error("Invalid workflow run id");
  }
  const base =
    options.repository ?? (await preflightWorkflowRepository(options));
  const branch = `pi/workflow/${options.runId}`;
  const worktreePath = path.resolve(options.worktreeBaseDir, options.runId);
  await mkdir(options.worktreeBaseDir, { recursive: true });

  const validateCreated = async (): Promise<WorkflowWorktree> => {
    const canonicalWorktree = await canonical(worktreePath);
    const validatedRoot = await canonical(
      await git(
        options.exec,
        ["rev-parse", "--show-toplevel"],
        canonicalWorktree,
        options.signal,
      ),
      canonicalWorktree,
    );
    const validatedCommon = await canonical(
      await git(
        options.exec,
        ["rev-parse", "--git-common-dir"],
        canonicalWorktree,
        options.signal,
      ),
      canonicalWorktree,
    );
    const validatedHead = await git(
      options.exec,
      ["rev-parse", "HEAD"],
      canonicalWorktree,
      options.signal,
    );
    const validatedBranch = await git(
      options.exec,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      canonicalWorktree,
      options.signal,
    );
    if (!samePath(validatedRoot, canonicalWorktree)) {
      throw new Error("Created worktree root failed canonical-path validation");
    }
    if (!samePath(validatedCommon, base.commonGitDir)) {
      throw new Error(
        "Created worktree belongs to a different common Git directory; refusing to inherit project trust",
      );
    }
    if (validatedHead !== base.baseCommit) {
      throw new Error(
        "Created worktree HEAD does not match the validated base commit",
      );
    }
    if (validatedBranch !== branch) {
      throw new Error(
        "Created worktree branch does not match the reserved workflow branch",
      );
    }
    return { ...base, branch, worktreePath: canonicalWorktree };
  };

  const argv = [
    "worktree",
    "add",
    "--lock",
    "-b",
    branch,
    worktreePath,
    base.baseCommit,
  ];
  const added = await options.exec("git", argv, {
    cwd: base.repoRoot,
    signal: options.signal,
    timeout: 60_000,
  });
  if (added.code !== 0) {
    // Git can report failure after materializing state. Reconcile only by
    // validating the exact requested path/common-dir/HEAD/branch; never force
    // remove or reset partial state.
    try {
      return await validateCreated();
    } catch {
      throw new Error(
        `${gitError(argv, added).message}. Partial Git state, if any, was retained; no force cleanup was attempted.`,
      );
    }
  }
  return validateCreated();
}

export async function summarizeWorkflowWorktree(options: {
  exec: GitExec;
  worktreePath: string;
  signal?: AbortSignal;
}): Promise<WorktreeSummary> {
  const finalHead = await git(
    options.exec,
    ["rev-parse", "HEAD"],
    options.worktreePath,
    options.signal,
  );
  const porcelain = await git(
    options.exec,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options.worktreePath,
    options.signal,
  );
  const lines = porcelain ? porcelain.split(/\r?\n/) : [];
  return {
    finalHead,
    dirty: lines.length > 0,
    dirtySummary:
      lines.length === 0
        ? "clean"
        : `${lines.length} changed path${lines.length === 1 ? "" : "s"}: ${lines.slice(0, 20).join("; ")}${lines.length > 20 ? "; …" : ""}`,
  };
}

/**
 * Revalidate every persisted identity field and require the recorded symbolic
 * branch. This is called both before confirmation and immediately before
 * removal; a detached or switched worktree is always retained.
 */
export async function validateWorkflowWorktreeForCleanup(options: {
  exec: GitExec;
  record: WorkflowWorktree;
  signal?: AbortSignal;
}): Promise<WorktreeCleanupIdentity> {
  if (!/^pi\/workflow\/[A-Za-z0-9_-]+$/.test(options.record.branch)) {
    throw new Error(
      "Recorded workflow branch name is invalid; refusing cleanup",
    );
  }
  if (!/^[0-9a-f]{40,64}$/i.test(options.record.baseCommit)) {
    throw new Error("Recorded workflow base HEAD is invalid; refusing cleanup");
  }
  const recordedRepoRoot = await canonical(options.record.repoRoot);
  const recordedCommonGitDir = await canonical(options.record.commonGitDir);
  const recordedWorktreePath = await canonical(options.record.worktreePath);
  const actualRepoRoot = await canonical(
    await git(
      options.exec,
      ["rev-parse", "--show-toplevel"],
      options.record.repoRoot,
      options.signal,
    ),
    options.record.repoRoot,
  );
  const worktreeRoot = await canonical(
    await git(
      options.exec,
      ["rev-parse", "--show-toplevel"],
      recordedWorktreePath,
      options.signal,
    ),
    recordedWorktreePath,
  );
  const repoCommonGitDir = await canonical(
    await git(
      options.exec,
      ["rev-parse", "--git-common-dir"],
      actualRepoRoot,
      options.signal,
    ),
    actualRepoRoot,
  );
  const worktreeCommonGitDir = await canonical(
    await git(
      options.exec,
      ["rev-parse", "--git-common-dir"],
      recordedWorktreePath,
      options.signal,
    ),
    recordedWorktreePath,
  );

  if (!samePath(actualRepoRoot, recordedRepoRoot)) {
    throw new Error(
      "Recorded repository root no longer matches the canonical Git repository; refusing cleanup",
    );
  }
  if (!samePath(worktreeRoot, recordedWorktreePath)) {
    throw new Error(
      "Recorded worktree path no longer matches its canonical Git root; refusing cleanup",
    );
  }
  if (
    !samePath(repoCommonGitDir, recordedCommonGitDir) ||
    !samePath(worktreeCommonGitDir, recordedCommonGitDir)
  ) {
    throw new Error(
      "Recorded worktree/repository common Git directory no longer matches; refusing cleanup",
    );
  }

  let branch: string;
  try {
    branch = await git(
      options.exec,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      recordedWorktreePath,
      options.signal,
    );
  } catch {
    throw new Error(
      "Refusing to clean up a detached workflow worktree; reattach the recorded branch first",
    );
  }
  if (branch !== options.record.branch) {
    throw new Error(
      `Refusing to clean up a workflow worktree switched to "${branch}"; expected "${options.record.branch}"`,
    );
  }

  const currentHead = await git(
    options.exec,
    ["rev-parse", "HEAD"],
    recordedWorktreePath,
    options.signal,
  );
  const branchHead = await git(
    options.exec,
    ["rev-parse", `refs/heads/${options.record.branch}`],
    actualRepoRoot,
    options.signal,
  );
  if (branchHead !== currentHead) {
    throw new Error(
      "Recorded workflow branch does not point at the worktree HEAD; refusing cleanup",
    );
  }

  return {
    currentHead,
    branch,
    repoRoot: actualRepoRoot,
    commonGitDir: repoCommonGitDir,
    worktreePath: recordedWorktreePath,
  };
}

/** Remove a retained clean worktree, then explicitly delete its retained branch. */
export async function cleanupWorkflowWorktree(options: {
  exec: GitExec;
  record: WorkflowWorktree & { status?: string };
  /** HEAD shown in the destructive confirmation; any later change aborts. */
  expectedHead?: string;
  signal?: AbortSignal;
}) {
  if (options.record.status === "running") {
    throw new Error("Refusing to clean up a running workflow worktree");
  }
  const initialIdentity = await validateWorkflowWorktreeForCleanup({
    exec: options.exec,
    record: options.record,
    signal: options.signal,
  });
  if (
    options.expectedHead !== undefined &&
    initialIdentity.currentHead !== options.expectedHead
  ) {
    throw new Error(
      "Workflow worktree HEAD changed after confirmation; refusing cleanup",
    );
  }
  const summary = await summarizeWorkflowWorktree({
    exec: options.exec,
    worktreePath: options.record.worktreePath,
    signal: options.signal,
  });
  if (summary.dirty) {
    throw new Error(
      `Refusing to clean up a dirty workflow worktree (${summary.dirtySummary})`,
    );
  }
  // A workflow worktree is intentionally locked for its lifetime. Explicit
  // confirmed cleanup unlocks it, rechecks cleanliness, then removes it
  // without force. A newly dirty tree is relocked and retained.
  await git(
    options.exec,
    ["worktree", "unlock", options.record.worktreePath],
    options.record.repoRoot,
    options.signal,
  );
  const afterUnlock = await summarizeWorkflowWorktree({
    exec: options.exec,
    worktreePath: options.record.worktreePath,
    signal: options.signal,
  });
  if (afterUnlock.dirty) {
    await git(
      options.exec,
      ["worktree", "lock", options.record.worktreePath],
      options.record.repoRoot,
      options.signal,
    ).catch(() => "");
    throw new Error(
      `Refusing to clean up a worktree that became dirty (${afterUnlock.dirtySummary})`,
    );
  }
  try {
    const finalIdentity = await validateWorkflowWorktreeForCleanup({
      exec: options.exec,
      record: options.record,
      signal: options.signal,
    });
    if (
      options.expectedHead !== undefined &&
      finalIdentity.currentHead !== options.expectedHead
    ) {
      throw new Error(
        "Workflow worktree HEAD changed after confirmation; refusing cleanup",
      );
    }
  } catch (error) {
    await git(
      options.exec,
      ["worktree", "lock", options.record.worktreePath],
      options.record.repoRoot,
      options.signal,
    ).catch(() => "");
    throw error;
  }
  await git(
    options.exec,
    ["worktree", "remove", options.record.worktreePath],
    options.record.repoRoot,
    options.signal,
  );
  // The caller has already obtained explicit destructive TUI confirmation.
  // A clean workflow worktree may still contain unmerged commits, so `-d`
  // would remove the worktree and then strand the branch in a partial cleanup.
  await git(
    options.exec,
    ["branch", "-D", options.record.branch],
    options.record.repoRoot,
    options.signal,
  );
  return summary;
}
