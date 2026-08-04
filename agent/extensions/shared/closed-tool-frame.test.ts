import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  closedToolFrame,
  closedToolFrameResult,
  closedToolFrameTop,
  closedToolFrameTopComponent,
  toolFrameStatus,
} from "./closed-tool-frame.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("closed tool frames keep both rails and exact width", () => {
  const width = 42;
  const component = closedToolFrame(
    "demo title",
    new Text(
      "short\na much longer body line that must be clipped safely",
      0,
      0,
    ),
    "success",
    theme,
    "done",
  );
  const lines = component.render(width);

  assert.match(lines[0] ?? "", /^╭.*╮$/u);
  assert.match(lines.at(-1) ?? "", /^╰.*╯$/u);
  for (const line of lines.slice(1, -1)) assert.match(line, /^│.*│$/u);
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});

test("split call/result components form one closed shell", () => {
  const width = 24;
  const lines = [
    ...closedToolFrameTop("tool", "pending", theme).render(width),
    ...closedToolFrameResult(
      new Text("working", 0, 0),
      "pending",
      theme,
    ).render(width),
  ];
  assert.match(lines[0] ?? "", /^╭.*╮$/u);
  assert.match(lines.at(-1) ?? "", /^╰.*╯$/u);
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});

test("component titles preserve multiline previews inside both rails", () => {
  const width = 32;
  const lines = closedToolFrameTopComponent(
    new Text("edit demo.ts\n- old value\n+ new value", 0, 0),
    "success",
    theme,
  ).render(width);

  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^╭.*╮$/u);
  assert.ok(lines.slice(1).every((line) => /^│.*│$/u.test(line)));
  assert.ok(lines.some((line) => line.includes("new value")));
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});

test("component titles remove OSC hyperlinks before fitting the border", () => {
  const width = 80;
  const linkedTitle =
    "read \x1b]8;;file:///very/long/path\x1b\\C:/very/long/path/file.ts\x1b]8;;\x1b\\";
  const lines = closedToolFrameTopComponent(
    new Text(linkedTitle, 0, 0),
    "success",
    theme,
  ).render(width);

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /\x1b\]/u);
  const plain = (lines[0] ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(plain, /^╭─ read C:\/very\/long\/path\/file\.ts ─+╮$/u);
  assert.equal(visibleWidth(lines[0] ?? ""), width);
});

test("tool frame status prioritizes errors", () => {
  assert.equal(toolFrameStatus({ isError: true, isPartial: true }), "error");
  assert.equal(toolFrameStatus({ isPartial: true }), "pending");
  assert.equal(toolFrameStatus({}), "success");
});
