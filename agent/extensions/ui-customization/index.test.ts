import assert from "node:assert/strict";
import test from "node:test";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import uiCustomization from "./index.ts";

const RELOAD_TEXT =
  "Reloading keybindings, extensions, skills, prompts, themes, and context files...";

class DynamicBorder {
  invalidate() {}

  render(width: number) {
    return ["─".repeat(width)];
  }
}

class Spacer {
  invalidate() {}

  render() {
    return [""];
  }
}

class Text {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  invalidate() {}

  render() {
    return [this.value];
  }
}

test("frames only the reload box, not its ancestor containers", () => {
  uiCustomization({
    events: { on: () => () => {} },
    on: () => {},
    registerTool: () => {},
  } as never);

  const state = (
    Container.prototype as unknown as Record<
      symbol,
      { theme: { fg: (_color: string, value: string) => string } }
    >
  )[Symbol.for("pi-config.selector-frame-state")];
  state.theme = { fg: (_color, value) => value };

  const reloadBox = new Container();
  reloadBox.addChild(new DynamicBorder());
  reloadBox.addChild(new Spacer());
  reloadBox.addChild(new Text(RELOAD_TEXT));
  reloadBox.addChild(new Spacer());
  reloadBox.addChild(new DynamicBorder());

  const root = new Container();
  root.addChild(new Text("before"));
  root.addChild(reloadBox);
  root.addChild(new Text("after"));

  const lines = root.render(40);
  assert.equal(lines[0], "before");
  assert.equal(lines.at(-1), "after");
  assert.equal(lines.filter((line) => line.startsWith("╭")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("╰")).length, 1);
  assert.ok(lines.some((line) => line.includes(RELOAD_TEXT.slice(0, 20))));
});

test("renders read with the same closed full-width shell as search tools", () => {
  let readTool:
    | {
        renderCall: (...args: never[]) => { render(width: number): string[] };
        renderResult: (...args: never[]) => { render(width: number): string[] };
      }
    | undefined;
  uiCustomization({
    events: { on: () => () => {} },
    on: () => {},
    registerTool: (tool: { name?: string }) => {
      if (tool.name === "read") readTool = tool as typeof readTool;
    },
  } as never);

  assert.ok(readTool);
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const context = {
    args: { path: "demo.txt" },
    cwd: process.cwd(),
    expanded: true,
    showImages: true,
    isError: false,
    isPartial: false,
    state: {},
  };
  const width = 48;
  readTool.renderCall(context.args as never, theme as never, context as never);
  readTool.renderResult(
    { content: [{ type: "text", text: "hello" }] } as never,
    { expanded: true, isPartial: false } as never,
    theme as never,
    context as never,
  );
  const lines = [
    ...readTool
      .renderCall(context.args as never, theme as never, context as never)
      .render(width),
    ...readTool
      .renderResult(
        { content: [{ type: "text", text: "hello" }] } as never,
        { expanded: true, isPartial: false } as never,
        theme as never,
        context as never,
      )
      .render(width),
  ];

  assert.match(lines[0] ?? "", /^╭.*╮$/u);
  assert.match(lines.at(-1) ?? "", /^╰.*╯$/u);
  assert.ok(lines.slice(1, -1).every((line) => /^│.*│$/u.test(line)));
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});

test("renders edit previews inside a closed full-width shell", () => {
  let editTool:
    | {
        renderCall: (...args: never[]) => { render(width: number): string[] };
        renderResult: (...args: never[]) => { render(width: number): string[] };
      }
    | undefined;
  uiCustomization({
    events: { on: () => () => {} },
    on: () => {},
    registerTool: (tool: { name?: string }) => {
      if (tool.name === "edit") editTool = tool as typeof editTool;
    },
  } as never);

  assert.ok(editTool);
  const theme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
  const context = {
    args: {
      path: "demo.txt",
      edits: [{ oldText: "old", newText: "new" }],
    },
    cwd: process.cwd(),
    expanded: true,
    showImages: true,
    isError: false,
    isPartial: false,
    argsComplete: false,
    state: {},
    invalidate() {},
  };
  const result = {
    content: [{ type: "text", text: "Successfully replaced 1 block." }],
    details: undefined,
  };
  const call = editTool.renderCall(
    context.args as never,
    theme as never,
    context as never,
  );
  const renderedResult = editTool.renderResult(
    result as never,
    { expanded: true, isPartial: false } as never,
    theme as never,
    context as never,
  );
  const width = 64;
  const lines = [...call.render(width), ...renderedResult.render(width)];

  assert.match(lines[0] ?? "", /^╭.*╮$/u);
  assert.match(lines.at(-1) ?? "", /^╰.*╯$/u);
  assert.ok(lines.slice(1, -1).every((line) => /^│.*│$/u.test(line)));
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});
