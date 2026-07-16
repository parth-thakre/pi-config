import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  cleanupWorkflowWorktree,
  createWorkflowWorktree,
  preflightWorkflowRepository,
  type GitExec,
} from "./worktree.ts";

const execFileAsync = promisify(execFile);
const exec: GitExec = async (command, argv, options) => {
  try {
    const result = await execFileAsync(command, argv, {
      cwd: options?.cwd,
      signal: options?.signal,
      timeout: options?.timeout,
      windowsHide: true,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === "number" ? failure.code : 1,
      killed: failure.killed,
    };
  }
};

async function git(cwd: string, ...argv: string[]) {
  const result = await exec("git", argv, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "pi workflow ü space "));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "workflow-test@example.invalid");
  await git(root, "config", "user.name", "Workflow Test");
  await git(root, "init", "--bare", ".origin.git");
  await writeFile(path.join(root, ".gitignore"), ".origin.git/\n");
  await writeFile(path.join(root, "hello ü.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  await git(root, "remote", "add", "origin", path.join(root, ".origin.git"));
  await git(root, "push", "-u", "origin", "main");
  return root;
}

test("preflight rejects non-Git and dirty parents without altering files", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "pi-workflow-nongit-"));
  await assert.rejects(
    preflightWorkflowRepository({ exec, cwd: outside }),
    /require a Git repository/,
  );
  await rm(outside, { recursive: true, force: true });

  const root = await repository();
  try {
    await writeFile(path.join(root, "dirty.txt"), "retain me");
    await assert.rejects(
      preflightWorkflowRepository({ exec, cwd: root }),
      /Parent checkout is dirty/,
    );
    assert.equal(await git(root, "status", "--porcelain"), "?? dirty.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default base fetches latest origin/main while explicit HEAD uses local HEAD", async () => {
  const root = await repository();
  const base = await mkdtemp(path.join(tmpdir(), "pi workflow bases "));
  try {
    const original = await git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "remote-latest.txt"), "latest\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "remote latest");
    const remoteLatest = await git(root, "rev-parse", "HEAD");
    await git(root, "push", "origin", "main");
    await git(root, "reset", "--hard", original);

    const fromDefault = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_origin_main",
      worktreeBaseDir: base,
    });
    assert.equal(fromDefault.baseRef, "origin/main");
    assert.equal(fromDefault.baseCommit, remoteLatest);
    assert.equal(
      await git(fromDefault.worktreePath, "rev-parse", "HEAD"),
      remoteLatest,
    );
    assert.equal(
      await git(
        root,
        "for-each-ref",
        "--format=%(refname)",
        "refs/pi/workflow-base",
      ),
      "",
    );

    const fromHead = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_local_head",
      worktreeBaseDir: base,
      base: "HEAD",
    });
    assert.equal(fromHead.baseRef, "HEAD");
    assert.equal(fromHead.baseCommit, original);
    assert.equal(
      await git(fromHead.worktreePath, "rev-parse", "HEAD"),
      original,
    );

    await cleanupWorkflowWorktree({
      exec,
      record: { ...fromDefault, status: "completed" },
    });
    await cleanupWorkflowWorktree({
      exec,
      record: { ...fromHead, status: "completed" },
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent runs create distinct locked worktrees on new branches", async () => {
  const root = await repository();
  const base = path.join(root, "short wt");
  await mkdir(base);
  try {
    const [first, second] = await Promise.all([
      createWorkflowWorktree({
        exec,
        cwd: root,
        runId: "wf_one",
        worktreeBaseDir: base,
      }),
      createWorkflowWorktree({
        exec,
        cwd: root,
        runId: "wf_two",
        worktreeBaseDir: base,
      }),
    ]);
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branch, second.branch);
    assert.equal(first.baseCommit, second.baseCommit);
    assert.equal(first.commonGitDir, second.commonGitDir);
    assert.equal(
      await git(first.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
      first.branch,
    );
    assert.equal(
      await git(second.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
      second.branch,
    );

    await cleanupWorkflowWorktree({
      exec,
      record: { ...first, status: "completed" },
    });
    await cleanupWorkflowWorktree({
      exec,
      record: { ...second, status: "completed" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a post-materialization add error is reconciled without force cleanup", async () => {
  const root = await repository();
  const base = path.join(root, "wt");
  const ambiguousExec: GitExec = async (command, argv, options) => {
    const result = await exec(command, argv, options);
    if (argv[0] === "worktree" && argv[1] === "add" && result.code === 0) {
      return { ...result, code: 1, stderr: "simulated late git failure" };
    }
    return result;
  };
  try {
    const worktree = await createWorkflowWorktree({
      exec: ambiguousExec,
      cwd: root,
      runId: "wf_reconciled",
      worktreeBaseDir: base,
    });
    assert.equal(worktree.branch, "pi/workflow/wf_reconciled");
    await cleanupWorkflowWorktree({
      exec,
      record: { ...worktree, status: "completed" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed cleanup removes a clean worktree with unmerged commits and its branch", async () => {
  const root = await repository();
  const base = path.join(root, "wt");
  try {
    const worktree = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_committed",
      worktreeBaseDir: base,
    });
    await writeFile(
      path.join(worktree.worktreePath, "committed.txt"),
      "retained commit",
    );
    await git(worktree.worktreePath, "add", ".");
    await git(worktree.worktreePath, "commit", "-m", "workflow commit");
    assert.equal(await git(worktree.worktreePath, "status", "--porcelain"), "");

    await cleanupWorkflowWorktree({
      exec,
      record: { ...worktree, status: "completed" },
    });

    assert.equal(await git(root, "branch", "--list", worktree.branch), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses a clean HEAD that changed after destructive confirmation", async () => {
  const root = await repository();
  const base = path.join(root, "wt");
  try {
    const worktree = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_changed_after_confirm",
      worktreeBaseDir: base,
    });
    const confirmedHead = await git(worktree.worktreePath, "rev-parse", "HEAD");
    await writeFile(
      path.join(worktree.worktreePath, "late.txt"),
      "late commit",
    );
    await git(worktree.worktreePath, "add", ".");
    await git(worktree.worktreePath, "commit", "-m", "late commit");
    await assert.rejects(
      cleanupWorkflowWorktree({
        exec,
        record: { ...worktree, status: "completed" },
        expectedHead: confirmedHead,
      }),
      /HEAD changed after confirmation/,
    );
    assert.notEqual(
      await git(worktree.worktreePath, "rev-parse", "HEAD"),
      confirmedHead,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses detached and switched worktrees without deleting their commits", async () => {
  const root = await repository();
  const base = path.join(root, "wt");
  try {
    const detached = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_detached",
      worktreeBaseDir: base,
    });
    await git(detached.worktreePath, "checkout", "--detach");
    await writeFile(path.join(detached.worktreePath, "detached.txt"), "commit");
    await git(detached.worktreePath, "add", ".");
    await git(detached.worktreePath, "commit", "-m", "detached commit");
    const detachedHead = await git(detached.worktreePath, "rev-parse", "HEAD");
    await assert.rejects(
      cleanupWorkflowWorktree({
        exec,
        record: { ...detached, status: "completed" },
      }),
      /detached/,
    );
    assert.equal(
      await git(detached.worktreePath, "rev-parse", "HEAD"),
      detachedHead,
    );
    await git(detached.worktreePath, "branch", "detached-rescue", detachedHead);
    await git(detached.worktreePath, "checkout", detached.branch);
    await cleanupWorkflowWorktree({
      exec,
      record: { ...detached, status: "completed" },
    });

    const switched = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_switched",
      worktreeBaseDir: base,
    });
    await git(switched.worktreePath, "checkout", "-b", "alternate-work");
    await assert.rejects(
      cleanupWorkflowWorktree({
        exec,
        record: { ...switched, status: "completed" },
      }),
      /switched/,
    );
    assert.equal(
      await git(switched.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
      "alternate-work",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses running and dirty retained worktrees", async () => {
  const root = await repository();
  const base = path.join(root, "wt");
  try {
    const worktree = await createWorkflowWorktree({
      exec,
      cwd: root,
      runId: "wf_dirty",
      worktreeBaseDir: base,
    });
    await assert.rejects(
      cleanupWorkflowWorktree({
        exec,
        record: { ...worktree, status: "running" },
      }),
      /running/,
    );
    await writeFile(
      path.join(worktree.worktreePath, "retained.txt"),
      "uncommitted",
    );
    await assert.rejects(
      cleanupWorkflowWorktree({
        exec,
        record: { ...worktree, status: "failed" },
      }),
      /dirty/,
    );
    assert.match(
      await git(worktree.worktreePath, "status", "--porcelain"),
      /retained.txt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
