import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildTranscriptLines } from "../subagents/src/ui/transcript.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import {
  buildWorkflowTranscriptRows,
  composeDashboardPanel,
  createWorkflowTranscriptRowsCache,
  displayLine,
  reconcileTranscriptOffset,
  transcriptViewport,
  updateTranscriptOffset,
} from "./dashboard.ts";
import type { AgentRecord, Theme, TranscriptEntry } from "./model.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as Theme;

function agentWith(transcript: TranscriptEntry[]): AgentRecord {
  return {
    index: 1,
    label: "renderer",
    phase: "Verify",
    state: "running",
    startedAt: 1,
    preview: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    transcript,
  };
}

test("pure transcript rows and panels bound hostile unbreakable output", () => {
  const hostile =
    "\u001b]8;;https://attacker.invalid\u0007" +
    "x".repeat(240) +
    "\u001b]8;;\u001b\\\n" +
    "\u009b12345Ctail\u0007";
  const transcript: TranscriptEntry[] = [
    {
      role: "toolResult",
      name: "bash\u001b(0",
      text: hostile,
    },
  ];
  const agent = agentWith(transcript);
  const persistedBefore = JSON.stringify(transcript);
  const requestedWidth = 34;

  const rows = buildWorkflowTranscriptRows(agent, requestedWidth - 2, theme);
  assert.ok(rows.length > 4, "the long token should wrap");
  assert.ok(rows.every((line) => visibleWidth(line) <= requestedWidth - 2));
  assert.ok(
    rows.every(
      (line) => !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(line),
    ),
  );
  assert.ok(rows.every((line) => !line.includes("attacker.invalid")));

  const panel = composeDashboardPanel(
    theme,
    "Transcript",
    rows,
    requestedWidth,
    12,
  );
  assert.equal(panel.length, 12);
  for (const [index, line] of panel.entries()) {
    assert.equal(visibleWidth(line), requestedWidth);
    const characters = Array.from(line);
    assert.equal(characters[0], index === 0 ? "╭" : index === 11 ? "╰" : "│");
    assert.equal(
      characters.at(-1),
      index === 0 ? "╮" : index === 11 ? "╯" : "│",
    );
  }
  assert.equal(JSON.stringify(transcript), persistedBefore);
  assert.equal(transcript[0]?.text, hostile);
});

test("workflow display metadata strips terminal controls without mutating source", () => {
  const raw = "name\u001b]0;owned\u0007\u001b[31m red\u001b[0m\nnext";
  assert.equal(displayLine(raw), "name red next");
  assert.match(raw, /owned/);
});

test("transcript viewport follows at offset zero and preserves a scrolled view", () => {
  const original = Array.from({ length: 10 }, (_, index) => `row-${index}`);
  const appended = [...original, "row-10", "row-11"];

  assert.deepEqual(transcriptViewport(original, 3, 0).visible, [
    "row-7",
    "row-8",
    "row-9",
  ]);
  assert.deepEqual(transcriptViewport(appended, 3, 0).visible, [
    "row-9",
    "row-10",
    "row-11",
  ]);

  const priorOffset = 3;
  const stableOffset = reconcileTranscriptOffset(
    priorOffset,
    original.length,
    appended.length,
  );
  assert.deepEqual(transcriptViewport(original, 3, priorOffset).visible, [
    "row-4",
    "row-5",
    "row-6",
  ]);
  assert.deepEqual(transcriptViewport(appended, 3, stableOffset).visible, [
    "row-4",
    "row-5",
    "row-6",
  ]);
});

test("g and G actions map to transcript top and bottom", () => {
  assert.equal(updateTranscriptOffset(0, 42, "top", 20, 10), 42);
  assert.equal(updateTranscriptOffset(42, 42, "bottom", 20, 10), 0);
  assert.equal(updateTranscriptOffset(0, 42, "older", 20, 10), 20);
  assert.equal(updateTranscriptOffset(20, 42, "newer", 20, 10), 0);
});

test("transcript row cache invalidates only for reference or width", () => {
  let builds = 0;
  const cache = createWorkflowTranscriptRowsCache(
    (agent, width, currentTheme) => {
      builds++;
      return buildWorkflowTranscriptRows(agent, width, currentTheme);
    },
  );
  const transcript: TranscriptEntry[] = [{ role: "assistant", text: "same" }];
  const firstAgent = agentWith(transcript);

  const first = cache.get(firstAgent, 40, theme);
  assert.equal(builds, 1);
  assert.equal(cache.get(firstAgent, 40, theme), first);
  assert.equal(builds, 1);

  const changedMetadata = { ...firstAgent, label: "changed" };
  assert.equal(cache.get(changedMetadata, 40, theme), first);
  assert.equal(builds, 1);

  const reflowed = cache.get(firstAgent, 20, theme);
  assert.notEqual(reflowed, first);
  assert.equal(builds, 2);

  const newReference = agentWith([...transcript]);
  assert.notEqual(cache.get(newReference, 20, theme), reflowed);
  assert.equal(builds, 3);
});

test("workflow transcript renders markdown and separates reasoning from tools", () => {
  const rows = buildWorkflowTranscriptRows(
    agentWith([
      {
        role: "assistant",
        text: "# Result\n\nA **bold** answer.\n\n- first\n- second",
      },
      { role: "thinking", text: "**Check the edge cases carefully.**" },
      { role: "thinking", text: "Then verify the fallback." },
      { role: "tool", name: "rg", text: '{"pattern":"needle"}' },
      { role: "toolResult", name: "rg", text: "src/file.ts:4:needle" },
    ]),
    48,
    theme,
  );
  const output = rows.join("\n");

  assert.match(output, /Result/);
  assert.match(output, /A bold answer\./);
  assert.doesNotMatch(output, /\*\*bold\*\*/);
  assert.equal(output.match(/◇ reasoning/g)?.length, 1);
  assert.match(output, /│ Check the edge cases carefully\./);
  assert.match(output, /│ Then verify the fallback\./);
  assert.doesNotMatch(output, /\*\*Check/);
  assert.match(output, /▶ rg/);
  assert.match(output, /└ ✓ result/);
  assert.ok(rows.every((line) => visibleWidth(line) <= 48));
});

test("subagent and workflow transcripts share markdown, reasoning, and tool language", () => {
  const snapshot: SubagentSnapshot = {
    id: "sub-style",
    backend: "pi",
    title: "child",
    prompt: "prompt",
    cwd: ".",
    status: "running",
    createdAt: 1,
    meta: { backend: "pi" },
    usage: {},
    transcript: [
      {
        kind: "assistant",
        parts: [{ type: "text", text: "## Answer\n\nUse `code`." }],
      },
      {
        kind: "assistant",
        parts: [{ type: "thinking", text: "Reason quietly." }],
      },
      {
        kind: "assistant",
        parts: [{ type: "thinking", text: "**Continue reasoning.**" }],
      },
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId: "tool-1",
            name: "read",
            argsPreview: '{"path":"x"}',
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "tool-1",
        name: "read",
        outputPreview: "file contents",
        isError: false,
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
  const output = buildTranscriptLines(snapshot, 48, theme).join("\n");

  assert.match(output, /Answer/);
  assert.doesNotMatch(output, /## Answer/);
  assert.equal(output.match(/◇ reasoning/g)?.length, 1);
  assert.doesNotMatch(output, /\*\*Continue reasoning/);
  assert.match(output, /▶ read/);
  assert.match(output, /└ ✓ result/);
});

test("subagent rendering leaves child/model transcript bytes untouched", () => {
  const raw = "\u001b[31mraw model text\u001b[0m\t\u0007";
  const snapshot: SubagentSnapshot = {
    id: "sub-1",
    backend: "pi",
    title: "child",
    prompt: "prompt",
    cwd: ".",
    status: "running",
    createdAt: 1,
    meta: { backend: "pi" },
    usage: {},
    transcript: [{ kind: "assistant", parts: [{ type: "text", text: raw }] }],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
  const before = JSON.stringify(snapshot.transcript);

  const rendered = buildTranscriptLines(snapshot, 40, theme);
  assert.ok(rendered.some((line) => line.includes("raw model text")));
  assert.ok(rendered.every((line) => !line.includes("\u001b")));
  assert.equal(JSON.stringify(snapshot.transcript), before);
  const part =
    snapshot.transcript[0]?.kind === "assistant"
      ? snapshot.transcript[0].parts[0]
      : undefined;
  assert.equal(part?.type === "text" ? part.text : undefined, raw);
});
