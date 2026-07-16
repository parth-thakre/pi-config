import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { TerminalSnapshot } from "./src/domain.ts";
import {
  BackgroundTerminalManager,
  POWERSHELL_WRAPPER,
  resolvePowerShell7,
  resolveTaskkill,
} from "./src/manager.ts";

const cwd = process.cwd();
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function poll(check: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

function settled(
  manager: BackgroundTerminalManager,
  id: string,
): Promise<TerminalSnapshot> {
  const current = manager.view.get(id);
  if (current?.status !== "running") return Promise.resolve(current!);
  return new Promise((resolve) => {
    const unsubscribe = manager.view.subscribeTo(id, () => {
      const snapshot = manager.view.get(id);
      if (snapshot && snapshot.status !== "running") {
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

async function run(
  command: string,
  options: { cwd?: string; manager?: BackgroundTerminalManager } = {},
) {
  const manager = options.manager ?? new BackgroundTerminalManager();
  const snapshot = manager.start({
    command,
    title: "integration",
    cwd: options.cwd ?? cwd,
  });
  const result = await settled(manager, snapshot.id);
  return { manager, result };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nodeCommand(script: string): string {
  if (script.includes("'"))
    throw new Error("test script cannot contain an apostrophe");
  return `node -e '${script}'`;
}

test(
  "resolves pwsh.exe and taskkill.exe from native Windows locations",
  { skip: process.platform !== "win32" },
  () => {
    assert.match(resolvePowerShell7(), /pwsh\.exe$/i);
    assert.equal(
      resolveTaskkill().toLowerCase(),
      path
        .join(process.env.SystemRoot!, "System32", "taskkill.exe")
        .toLowerCase(),
    );
    assert.match(POWERSHELL_WRAPPER, /OutputEncoding/);
    assert.doesNotMatch(POWERSHELL_WRAPPER, /ExecutionPolicy|cmd\.exe/i);
  },
);

test(
  "real PowerShell 7 preserves quoting, pipelines, environment expansion, Unicode, cwd spaces, streams, CRLF, and progress CR",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const spaced = fs.mkdtempSync(
      path.join(os.tmpdir(), "bt cwd with spaces "),
    );
    const previous = process.env.PI_BG_INTEGRATION_VALUE;
    process.env.PI_BG_INTEGRATION_VALUE = "expanded ✓";
    const command = [
      `[Console]::Out.WriteLine("it's safe")`,
      `1,2,3 | ForEach-Object { Write-Output ("pipe:" + ($_ * 2)) }`,
      `Write-Output $env:PI_BG_INTEGRATION_VALUE`,
      `[Console]::Out.WriteLine("Unicode: Ελληνικά 中文 👩🏽‍💻")`,
      `[Console]::Out.WriteLine("cwd:" + (Get-Location).Path)`,
      '[Console]::Out.Write("crlf`r`nprogress-1`rprogress-2")',
      `[Console]::Error.Write("stderr-only")`,
    ].join("; ");
    const { manager, result } = await run(command, { cwd: spaced });
    try {
      assert.equal(result.status, "done");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout.text, /it's safe/);
      assert.match(result.stdout.text, /pipe:2[\s\S]*pipe:4[\s\S]*pipe:6/);
      assert.match(result.stdout.text, /expanded ✓/);
      assert.match(result.stdout.text, /Unicode: Ελληνικά 中文 👩🏽‍💻/);
      const realSpaced = fs.realpathSync.native(spaced);
      assert.match(
        result.stdout.text,
        new RegExp(
          `cwd:${realSpaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "i",
        ),
      );
      assert.match(result.stdout.text, /crlf\r\nprogress-1\rprogress-2/);
      assert.equal(result.stderr.text, "stderr-only");
      assert.equal(result.stdout.text.includes("stderr-only"), false);
    } finally {
      await manager.disposeAll();
      fs.rmSync(spaced, { recursive: true, force: true });
      if (previous === undefined) delete process.env.PI_BG_INTEGRATION_VALUE;
      else process.env.PI_BG_INTEGRATION_VALUE = previous;
    }
  },
);

test(
  "real PowerShell wrapper returns native exit codes and maps cmdlet failures to one",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const native = await run(nodeCommand(`process.exit(7)`));
    try {
      assert.equal(native.result.status, "failed");
      assert.equal(native.result.exitCode, 7);
    } finally {
      await native.manager.disposeAll();
    }

    const cmdlet = await run(
      `Get-Item -LiteralPath "Z:\\definitely-missing-bg-terminal"`,
    );
    try {
      assert.equal(cmdlet.result.status, "failed");
      assert.equal(cmdlet.result.exitCode, 1);
      assert.ok(cmdlet.result.stderr.text.length > 0);
    } finally {
      await cmdlet.manager.disposeAll();
    }
  },
);

test(
  "natural exit settles once and remains truthful",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const manager = new BackgroundTerminalManager();
    const notifications: string[] = [];
    manager.view.setOnSettled((snapshot) =>
      notifications.push(`${snapshot.id}:${snapshot.status}`),
    );
    const snapshot = manager.start({
      command: `Write-Output "done"`,
      title: "natural",
      cwd,
    });
    const result = await settled(manager, snapshot.id);
    assert.equal(result.status, "done");
    assert.deepEqual(notifications, [`${snapshot.id}:done`]);
    const [kill] = await manager.kill([snapshot.id]);
    assert.equal(kill.wasRunning, false);
    assert.equal(kill.killed, false);
    assert.equal(kill.status, "done");
    await manager.disposeAll();
  },
);

function heartbeatCommand(file: string, parentExits: boolean): string {
  const childScript = `const fs=require("node:fs");const f=${JSON.stringify(file)};let n=0;fs.writeFileSync(f,"0");setInterval(()=>fs.writeFileSync(f,String(++n)),25)`;
  const parentScript = `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"inherit",windowsHide:true});console.log("grandchild:"+c.pid);${parentExits ? "setTimeout(()=>process.exit(0),300)" : "setInterval(()=>{},1000)"}`;
  return nodeCommand(parentScript);
}

async function waitForLiveHeartbeat(file: string): Promise<void> {
  assert.ok(await poll(() => fs.existsSync(file)), "heartbeat was created");
  const before = fs.readFileSync(file, "utf8");
  assert.ok(
    await poll(() => fs.readFileSync(file, "utf8") !== before),
    "heartbeat was live",
  );
}

async function assertHeartbeatStopped(file: string): Promise<void> {
  await delay(200);
  const stopped = fs.readFileSync(file, "utf8");
  await delay(200);
  assert.equal(fs.readFileSync(file, "utf8"), stopped, "heartbeat stopped");
}

test(
  "awaited /T and /T /F helpers terminate a real parent/grandchild tree",
  { skip: process.platform !== "win32", timeout: 25_000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-tree-"));
    const heartbeat = path.join(directory, "heartbeat.txt");
    const manager = new BackgroundTerminalManager({ gracefulWaitMs: 0 });
    try {
      const snapshot = manager.start({
        command: heartbeatCommand(heartbeat, false),
        title: "tree",
        cwd,
      });
      assert.ok(await poll(() => /grandchild:\d+/.test(snapshot.stdout.text)));
      const pid = Number(/grandchild:(\d+)/.exec(snapshot.stdout.text)![1]);
      await waitForLiveHeartbeat(heartbeat);
      const [report] = await manager.kill([snapshot.id]);
      assert.equal(report.status, "killed");
      assert.ok(report.helpers.some((helper) => helper.force === false));
      assert.ok(report.helpers.some((helper) => helper.force === true));
      assert.ok(
        await poll(() => !processExists(pid)),
        "actual grandchild process died",
      );
      await assertHeartbeatStopped(heartbeat);
    } finally {
      await manager.disposeAll();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "aborting a kill wait does not abort tree termination",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const manager = new BackgroundTerminalManager({ gracefulWaitMs: 0 });
    const snapshot = manager.start({
      command: nodeCommand(`setInterval(()=>{},1000)`),
      title: "abort",
      cwd,
    });
    const controller = new AbortController();
    const killing = manager.kill([snapshot.id], controller.signal);
    controller.abort();
    await assert.rejects(killing, /termination continues/);
    const result = await settled(manager, snapshot.id);
    assert.equal(result.status, "killed");
    await manager.disposeAll();
  },
);

test(
  "inherited-pipe cleanup is bounded and preserves a natural root exit",
  { skip: process.platform !== "win32", timeout: 25_000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-pipes-"));
    const heartbeat = path.join(directory, "heartbeat.txt");
    const manager = new BackgroundTerminalManager({
      inheritedPipeGraceMs: 200,
      forcedWaitMs: 500,
    });
    try {
      const snapshot = manager.start({
        command: heartbeatCommand(heartbeat, true),
        title: "pipes",
        cwd,
      });
      assert.ok(await poll(() => /grandchild:\d+/.test(snapshot.stdout.text)));
      const pid = Number(/grandchild:(\d+)/.exec(snapshot.stdout.text)![1]);
      await waitForLiveHeartbeat(heartbeat);
      const result = await settled(manager, snapshot.id);
      assert.equal(result.status, "done");
      assert.equal(result.exitCode, 0);
      assert.ok(
        await poll(() => !processExists(pid)),
        "inherited-pipe descendant died",
      );
      await assertHeartbeatStopped(heartbeat);
    } finally {
      await manager.disposeAll();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "session disposal kills jobs and completes within a bound",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const manager = new BackgroundTerminalManager();
    const snapshot = manager.start({
      command: nodeCommand(`setInterval(()=>{},1000)`),
      title: "dispose",
      cwd,
    });
    const pid = snapshot.pid!;
    const started = Date.now();
    await manager.disposeAll();
    assert.ok(Date.now() - started < 7_000);
    assert.ok(await poll(() => !processExists(pid)));
    assert.equal(manager.view.size(), 0);
  },
);

test(
  "pruning settled jobs deletes their spill segments during the session",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const manager = new BackgroundTerminalManager({
      retainedBytes: 16,
      spillSegmentBytes: 32,
      spillMaxFiles: 2,
    });
    try {
      let firstId = "";
      let firstFiles: readonly string[] = [];
      for (let index = 0; index <= 32; index++) {
        const snapshot = manager.start({
          command: `Write-Output "${"x".repeat(80)}-${index}"`,
          title: `job-${index}`,
          cwd,
        });
        const result = await settled(manager, snapshot.id);
        if (index === 0) {
          firstId = result.id;
          firstFiles = [...result.stdout.spillFiles, ...result.stderr.spillFiles];
          assert.ok(firstFiles.length > 0);
        }
      }
      assert.equal(manager.view.get(firstId), undefined);
      assert.ok(firstFiles.every((file) => !fs.existsSync(file)));
      assert.equal(manager.view.size(), 32);
    } finally {
      await manager.disposeAll();
    }
  },
);

test(
  "real firehose exceeds memory and rotating disk limits without unbounded retention",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async () => {
    const manager = new BackgroundTerminalManager({
      retainedBytes: 1024,
      spillSegmentBytes: 2048,
      spillMaxFiles: 2,
    });
    const script = `const s="x".repeat(1024);for(let i=0;i<20;i++){process.stdout.write(s);process.stderr.write(s)}`;
    const snapshot = manager.start({
      command: nodeCommand(script),
      title: "firehose",
      cwd,
    });
    const result = await settled(manager, snapshot.id);
    for (const output of [result.stdout, result.stderr]) {
      assert.equal(output.totalBytes, 20 * 1024);
      assert.ok(Buffer.byteLength(output.text) <= 1024);
      assert.ok(output.spillFiles.length <= 2);
      assert.ok(output.spillRetainedBytes <= 4096);
      assert.ok(output.spillDroppedBytes > 0);
      assert.equal(output.spillComplete, false);
    }
    await manager.disposeAll();
  },
);
