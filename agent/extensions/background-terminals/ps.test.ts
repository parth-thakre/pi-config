import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOutputLines,
  createOutputLineCache,
  oneLine,
} from "./src/ui/output-view.ts";
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/ps.ts";

test("/ps selection follows id and clamps when entries disappear", () => {
  const selection: DashboardSelection = { id: "bt-2", index: 1 };
  reconcileDashboardSelection(selection, [
    { id: "bt-new" },
    { id: "bt-1" },
    { id: "bt-2" },
  ]);
  assert.deepEqual(selection, { id: "bt-2", index: 2 });
  reconcileDashboardSelection(selection, [{ id: "bt-new" }, { id: "bt-1" }]);
  assert.deepEqual(selection, { id: "bt-1", index: 1 });
  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("/ps output uses the shared sanitizer for ANSI, OSC, tabs, CR progress, and controls", () => {
  const raw =
    "first\rfinal\n\u001b]0;hidden\u0007\u001b[31mred\u001b[0m\ta\u0000b";
  assert.deepEqual(buildOutputLines(raw, 80), ["final", "red  ab"]);
  assert.equal(oneLine("\u001b[31mtitle\u001b[0m\nnext"), "title next");
});

test("/ps output wraps to width and caches by version and width", () => {
  const cache = createOutputLineCache();
  const first = cache.get("x".repeat(25), 1, 10);
  assert.ok(first.length >= 3);
  assert.equal(first.join(""), "x".repeat(25));
  assert.equal(cache.get("ignored", 1, 10), first);
  assert.notEqual(cache.get("new", 2, 10), first);
});
