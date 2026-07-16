/**
 * Render-time sanitization for untrusted terminal text.
 *
 * Keep captured transcripts unchanged. Call this only at the display boundary,
 * before applying theme styles or measuring, wrapping, and truncating text.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_DCS = String.fromCharCode(0x90);
const C1_CSI = String.fromCharCode(0x9b);
const C1_ST = String.fromCharCode(0x9c);
const C1_OSC = String.fromCharCode(0x9d);
const C1_SOS = String.fromCharCode(0x98);
const C1_PM = String.fromCharCode(0x9e);
const C1_APC = String.fromCharCode(0x9f);

/** ESC or any C1 introducer that can start a multi-character sequence. */
const SEQUENCE_INTRODUCER = new RegExp(
  "[\\u001b\\u0090\\u0098\\u009b\\u009d-\\u009f]",
);
/** Anything sanitizeTerminalText would remove or rewrite. */
const NEEDS_SANITIZING = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
/** Loose control characters removed after sequence stripping. */
const CONTROL_CHARACTERS = new RegExp(
  "[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]",
  "g",
);

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
  if (!SEQUENCE_INTRODUCER.test(text)) return text;

  const parts: string[] = [];
  let index = 0;
  let plainStart = 0;
  const skipSequence = (start: number, end: number) => {
    if (start > plainStart) parts.push(text.slice(plainStart, start));
    plainStart = end;
    return end;
  };

  while (index < text.length) {
    const char = text[index];

    if (char === ESC) {
      const next = text[index + 1];
      if (next === "]") {
        index = skipSequence(
          index,
          consumeControlString(text, index + 2, true),
        );
      } else if (next === "[") {
        index = skipSequence(index, consumeCsi(text, index + 2));
      } else if (next === "P" || next === "X" || next === "^" || next === "_") {
        index = skipSequence(
          index,
          consumeControlString(text, index + 2, false),
        );
      } else {
        const consumed = consumeEscape(text, index + 1);
        index = skipSequence(
          index,
          consumed > index + 1 ? consumed : index + 1,
        );
      }
      continue;
    }

    if (char === C1_OSC) {
      index = skipSequence(index, consumeControlString(text, index + 1, true));
      continue;
    }
    if (char === C1_CSI) {
      index = skipSequence(index, consumeCsi(text, index + 1));
      continue;
    }
    if (
      char === C1_DCS ||
      char === C1_SOS ||
      char === C1_PM ||
      char === C1_APC
    ) {
      index = skipSequence(index, consumeControlString(text, index + 1, false));
      continue;
    }

    index++;
  }

  if (plainStart === 0) return text;
  if (plainStart < text.length) parts.push(text.slice(plainStart));
  return parts.join("");
}

function collapseProgressRewrites(text: string) {
  if (!text.includes("\r")) return text;
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
  // Fast path: most rendered lines contain no control characters at all.
  if (!NEEDS_SANITIZING.test(text)) return text;

  const normalizedNewlines = text.replaceAll("\r\n", "\n");
  const withoutTerminalSequences = stripTerminalSequences(normalizedNewlines);
  const withoutProgressHistory = collapseProgressRewrites(
    withoutTerminalSequences,
  );

  return withoutProgressHistory
    .replaceAll("\t", "  ")
    .replace(CONTROL_CHARACTERS, "");
}
