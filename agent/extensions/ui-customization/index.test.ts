import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
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
