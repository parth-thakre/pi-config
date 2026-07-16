import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderHeader } from "./flow-title.ts";
import { boundTropeResult, validateTropeTarget } from "./trope-cua.ts";

test("flow title truncates every header line to the render width", () => {
  const ctx = {
    model: {
      id: "model-with-a-very-long-name",
      provider: "provider-with-a-very-long-name",
    },
  } as unknown as ExtensionContext;
  for (const width of [0, 1, 12, 40, 80]) {
    const lines = renderHeader(width, ctx);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("Trope window operations require an explicit pid/window_id pair", () => {
  for (const tool of ["get_window_state", "screenshot", "click"] as const) {
    assert.throws(() => validateTropeTarget({ tool, args: {} }), /requires.*pid/);
    assert.throws(
      () => validateTropeTarget({ tool, args: { pid: 1 } }),
      /window_id/,
    );
    assert.doesNotThrow(() =>
      validateTropeTarget({ tool, args: { pid: 1, window_id: 2 } }),
    );
  }
  assert.doesNotThrow(() => validateTropeTarget({ tool: "list_windows" }));
});

test("Trope result bounds text, images, controls, and structured details in aggregate", () => {
  const image = Buffer.alloc(1024).toString("base64");
  const bounded = boundTropeResult({
    content: [
      { type: "text", text: `safe\u001b]0;hidden\u0007${"x".repeat(80_000)}` },
      ...Array.from({ length: 8 }, () => ({
        type: "image" as const,
        data: image,
        mimeType: "image/png",
      })),
    ],
    structuredContent: {
      huge: Array.from({ length: 100 }, (_, index) => ({
        index,
        text: "y".repeat(10_000),
      })),
    },
  });
  const text = bounded.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.doesNotMatch(text, /hidden|\u001b|\u0007/);
  assert.ok(Buffer.byteLength(text, "utf8") < 52 * 1024);
  assert.equal(
    bounded.content.filter((block) => block.type === "image").length,
    4,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.details), "utf8") < 20 * 1024);
});
