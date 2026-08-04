import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSubagentPanel, promptForSubagent } from "./src/ui/takeover.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("subagent panels fully enclose titles, content, and control hints", () => {
  const lines = composeSubagentPanel(
    theme,
    "by the way",
    ["answer", " enter send · esc back"],
    48,
    4,
    true,
  );

  assert.equal(lines.length, 4);
  assert.ok(lines[0]?.startsWith("╭"));
  assert.ok(lines[0]?.endsWith("╮"));
  assert.ok(lines[1]?.startsWith("│"));
  assert.ok(lines[1]?.endsWith("│"));
  assert.ok(lines[2]?.startsWith("│"));
  assert.ok(lines[2]?.endsWith("│"));
  assert.ok(lines[3]?.startsWith("╰"));
  assert.ok(lines[3]?.endsWith("╯"));
  assert.ok(lines.every((line) => visibleWidth(line) === 48));
});

test("by-the-way prompt replaces the open built-in dialog with a closed frame", async () => {
  let rendered: string[] = [];
  const ctx = {
    ui: {
      custom: (factory: any) =>
        new Promise<string | undefined>((resolve) => {
          const component = factory(
            { requestRender() {} },
            theme,
            {
              matches() {
                return false;
              },
              getKeys(binding: string) {
                return binding === "tui.input.submit" ? ["enter"] : ["escape"];
              },
            },
            resolve,
          );
          rendered = component.render(60);
          for (const character of "hello") component.handleInput(character);
          component.handleInput("\r");
        }),
    },
  } as unknown as ExtensionCommandContext;

  assert.equal(
    await promptForSubagent(ctx, "by the way", "Ask a one-off question…"),
    "hello",
  );
  assert.ok(rendered[0]?.startsWith("╭"));
  assert.ok(rendered[0]?.endsWith("╮"));
  assert.ok(
    rendered
      .slice(1, -1)
      .every((line) => line.startsWith("│") && line.endsWith("│")),
  );
  assert.ok(rendered.at(-1)?.startsWith("╰"));
  assert.ok(rendered.at(-1)?.endsWith("╯"));
  assert.ok(rendered.every((line) => visibleWidth(line) === 60));
});
