/**
 * Render-time sanitization for untrusted terminal text.
 *
 * Keep captured transcripts unchanged. Call this only at the display boundary,
 * before applying theme styles or measuring, wrapping, and truncating text.
 */

const ESC = "\u001b";
const BEL = "\u0007";
const C1_DCS = "\u0090";
const C1_CSI = "\u009b";
const C1_ST = "\u009c";
const C1_OSC = "\u009d";
const C1_SOS = "\u0098";
const C1_PM = "\u009e";
const C1_APC = "\u009f";

function isCodeInRange(char: string | undefined, start: number, end: number) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code >= start && code <= end;
}

function consumeControlString(text: string, start: number, allowBel: boolean) {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if ((allowBel && char === BEL) || char === C1_ST) return index + 1;
    if (char === ESC && text[index + 1] === "\\") return index + 2;
    index++;
  }
  // An unterminated terminal string remains non-visible in a terminal. Drop it
  // through end-of-input rather than exposing its payload as ordinary text.
  return text.length;
}

function consumeCsi(text: string, start: number) {
  let index = start;
  while (isCodeInRange(text[index], 0x30, 0x3f)) index++;
  while (isCodeInRange(text[index], 0x20, 0x2f)) index++;
  if (isCodeInRange(text[index], 0x40, 0x7e)) index++;
  return index;
}

function consumeEscape(text: string, start: number) {
  let index = start;
  while (isCodeInRange(text[index], 0x20, 0x2f)) index++;
  if (isCodeInRange(text[index], 0x30, 0x7e)) index++;
  return index;
}

function stripTerminalSequences(text: string) {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === ESC) {
      const next = text[index + 1];
      if (next === "]") {
        index = consumeControlString(text, index + 2, true);
      } else if (next === "[") {
        index = consumeCsi(text, index + 2);
      } else if (next === "P" || next === "X" || next === "^" || next === "_") {
        index = consumeControlString(text, index + 2, false);
      } else {
        const consumed = consumeEscape(text, index + 1);
        index = consumed > index + 1 ? consumed : index + 1;
      }
      continue;
    }

    if (char === C1_OSC) {
      index = consumeControlString(text, index + 1, true);
      continue;
    }
    if (char === C1_CSI) {
      index = consumeCsi(text, index + 1);
      continue;
    }
    if (
      char === C1_DCS ||
      char === C1_SOS ||
      char === C1_PM ||
      char === C1_APC
    ) {
      index = consumeControlString(text, index + 1, false);
      continue;
    }

    output += char;
    index++;
  }

  return output;
}

function collapseProgressRewrites(text: string) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      const final = segments.at(-1) ?? "";
      return (
        final ||
        [...segments].reverse().find((segment) => segment.length > 0) ||
        ""
      );
    })
    .join("\n");
}

/**
 * Convert captured terminal output into inert display text.
 *
 * Tabs expand to two spaces to match the existing lightweight transcript UI.
 * CRLF is normalized before standalone carriage returns are interpreted as
 * progress-line rewrites; a trailing CR therefore retains the last visible
 * non-empty segment.
 */
export function sanitizeTerminalText(text: string): string {
  const normalizedNewlines = text.replaceAll("\r\n", "\n");
  const withoutTerminalSequences = stripTerminalSequences(normalizedNewlines);
  const withoutProgressHistory = collapseProgressRewrites(
    withoutTerminalSequences,
  );

  return withoutProgressHistory
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}
