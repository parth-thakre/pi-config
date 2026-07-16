import assert from "node:assert/strict";
import { test } from "node:test";
import type { TerminalSnapshot } from "./src/domain.ts";
import { buildStatusResult, buildTerminalResultMessage } from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  RENDER_MAX_BYTES,
  collapsedToolResult,
  renderToolCallText,
  renderToolResultText,
} from "./src/ui/output-view.ts";

const summary = {
  id: "bt-7",
  title: "server",
  status: "running" as const,
  elapsed: "12s",
};

test("collapsed bg_start/status/list/kill rows contain only title, id, state, and elapsed", () => {
  const secret = "SECRET_COMMAND --token hidden cwd=C:\\private";
  const calls = [
    renderToolCallText("bg_start", { title: "server", command: secret }, false),
    renderToolCallText("bg_status", { id: "bt-7", secret }, false),
    renderToolCallText("bg_list", { secret }, false),
    renderToolCallText("bg_kill", { ids: ["bt-7"], secret }, false),
  ];
  assert.equal(
    calls.some((text) => text.includes(secret)),
    false,
  );

  const collapsed = collapsedToolResult({ summaries: [summary] });
  assert.equal(collapsed, "server · bt-7 · running · 12s");
  assert.equal(collapsed.includes("SECRET"), false);

  for (const name of ["bg_start", "bg_status", "bg_list", "bg_kill"] as const) {
    const rendered = renderToolResultText(
      {
        content: [{ type: "text", text: secret }],
        details: { summaries: [summary], cwd: "C:\\private", command: secret },
      },
      false,
    );
    assert.equal(rendered, "server · bt-7 · running · 12s", name);
  }
});

test("expanded tool output is sanitized and bounded", () => {
  const hostile = `\u001b]0;owned\u0007\u001b[31mred\u001b[0m\n${"x".repeat(RENDER_MAX_BYTES * 3)}`;
  const rendered = renderToolResultText(
    { content: [{ type: "text", text: hostile }], details: { summary } },
    true,
  );
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("owned"), false);
  assert.ok(Buffer.byteLength(rendered) <= RENDER_MAX_BYTES + 128);
});

function snapshotWithRaw(raw: string): TerminalSnapshot {
  const output = {
    text: raw,
    totalBytes: Buffer.byteLength(raw),
    truncatedBytes: 0,
    spillDirectory: "C:\\temp\\spill",
    spillFiles: ["C:\\temp\\spill\\0.log"],
    spillRetainedBytes: Buffer.byteLength(raw),
    spillDroppedBytes: 0,
    spillRotations: 0,
    spillComplete: true,
  };
  return {
    id: "bt-1",
    title: "\u001b[31mjob\u001b[0m",
    command: "raw",
    cwd: "C:\\repo",
    pid: 1,
    status: "done",
    createdAt: 0,
    settledAt: 1000,
    exitCode: 0,
    stdout: output,
    stderr: { ...output, text: "", totalBytes: 0, spillRetainedBytes: 0 },
  };
}

test("bg_status and completion messages share display sanitization while capture stays raw", () => {
  const raw =
    "old progress\rfinal\n\u001b]0;title\u0007\u001b[32msafe\u001b[0m";
  const snapshot = snapshotWithRaw(raw);
  const status = buildStatusResult(snapshot);
  const completion = buildTerminalResultMessage(snapshot);
  for (const text of [status, completion]) {
    assert.equal(text.includes("\u001b"), false);
    assert.equal(text.includes("title"), false);
    assert.match(text, /final[\s\S]*safe/);
    assert.equal(text.includes("old progress"), false);
  }
  assert.equal(snapshot.stdout.text, raw);
});

test("deferred completion delivery drains or consumes each id exactly once", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    value: number;
  }>();
  delivery.defer({ id: "bt-1", value: 1 });
  delivery.defer({ id: "bt-1", value: 2 });
  assert.deepEqual(delivery.drain(), [{ id: "bt-1", value: 2 }]);
  assert.deepEqual(delivery.drain(), []);
  delivery.defer({ id: "bt-2", value: 3 });
  delivery.consume(["bt-2"]);
  assert.deepEqual(delivery.drain(), []);
});
