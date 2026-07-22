import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  closedToolFrame,
  closedToolFrameResult,
  closedToolFrameTop,
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

test("tool frame status prioritizes errors", () => {
  assert.equal(toolFrameStatus({ isError: true, isPartial: true }), "error");
  assert.equal(toolFrameStatus({ isPartial: true }), "pending");
  assert.equal(toolFrameStatus({}), "success");
});
