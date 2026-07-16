import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "./terminal-text.ts";

test("sanitizeTerminalText normalizes newlines and progress rewrites", () => {
  assert.equal(sanitizeTerminalText("first\r\nsecond"), "first\nsecond");
  assert.equal(sanitizeTerminalText("progress 1\rprogress 2\rdone"), "done");
  assert.equal(sanitizeTerminalText("progress 1\rprogress 2\r"), "progress 2");
  assert.equal(sanitizeTerminalText("a\tbc\t"), "a  bc  ");
});

test("sanitizeTerminalText strips CSI with unbounded parameters", () => {
  assert.equal(sanitizeTerminalText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeTerminalText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeTerminalText("\u009b12345Cshifted"), "shifted");
});

test("sanitizeTerminalText strips OSC titles and hyperlinks", () => {
  assert.equal(
    sanitizeTerminalText("\u001b]0;window title\u0007output"),
    "output",
  );
  assert.equal(
    sanitizeTerminalText(
      "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
    ),
    "link",
  );
  assert.equal(
    sanitizeTerminalText(
      "\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\",
    ),
    "link",
  );
  assert.equal(sanitizeTerminalText("\u009d0;hidden\u009cvisible"), "visible");
});

test("sanitizeTerminalText strips remaining ESC forms and C0/C1 controls", () => {
  assert.equal(sanitizeTerminalText("a\u001b(0b\u001b7c"), "abc");
  assert.equal(sanitizeTerminalText("a\u0000b\u0007c\u0085d\u009ce"), "abcde");
});

test("sanitizeTerminalText preserves mixed Unicode", () => {
  const text = "naïve Ελληνικά 中文 العربية 👩🏽‍💻 e\u0301";
  assert.equal(sanitizeTerminalText(text), text);
});
