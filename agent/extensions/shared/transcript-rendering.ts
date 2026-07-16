import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.ts";

function transcriptMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

function bounded(lines: readonly string[], width: number) {
  return lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
}

/** Render assistant prose as actual Markdown after neutralizing terminal controls. */
export function renderAssistantMarkdown(
  theme: Theme,
  text: string,
  width: number,
): string[] {
  const clean = sanitizeTerminalText(text).trim();
  if (!clean || width <= 0) return [];
  const markdown = new Markdown(clean, 0, 0, transcriptMarkdownTheme(theme));
  return bounded(markdown.render(width), width);
}

/** Compact user prompt treatment shared by workflow and subagent transcripts. */
export function renderTranscriptUser(
  theme: Theme,
  text: string,
  width: number,
): string[] {
  const clean = sanitizeTerminalText(text).trim();
  if (!clean || width <= 0) return [];
  const marker = theme.fg("accent", "› ");
  const markerWidth = visibleWidth(marker);
  const wrapped = wrapTextWithAnsi(clean, Math.max(1, width - markerWidth));
  return bounded(
    wrapped.map(
      (line, index) =>
        (index === 0 ? marker : " ".repeat(markerWidth)) +
        theme.fg("userMessageText", line),
    ),
    width,
  );
}

function reasoningMarkdownTheme(theme: Theme): MarkdownTheme {
  const quiet = (text: string) => theme.fg("thinkingText", theme.italic(text));
  return {
    heading: (text) => quiet(theme.bold(text)),
    link: quiet,
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("dim", text),
    codeBlock: quiet,
    codeBlockBorder: (text) => theme.fg("borderMuted", text),
    quote: quiet,
    quoteBorder: (text) => theme.fg("borderMuted", text),
    hr: (text) => theme.fg("borderMuted", text),
    listBullet: (text) => theme.fg("dim", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

/** Reasoning is quieter than answers, Markdown-aware, and distinct from tools. */
export function renderReasoningTrace(
  theme: Theme,
  text: string,
  width: number,
  options: { showLabel?: boolean } = {},
): string[] {
  const clean = sanitizeTerminalText(text).trim();
  if (!clean || width <= 0) return [];
  const rail = theme.fg("borderMuted", "│ ");
  const railWidth = visibleWidth(rail);
  const markdown = new Markdown(clean, 0, 0, reasoningMarkdownTheme(theme), {
    color: (value) => theme.fg("thinkingText", value),
    italic: true,
  });
  const rendered = markdown.render(Math.max(1, width - railWidth));
  const rows = rendered.map((line) => rail + line);
  if (options.showLabel !== false) {
    rows.unshift(theme.fg("thinkingText", theme.italic("◇ reasoning")));
  }
  return bounded(rows, width);
}

/** Tool invocation treatment: strong verb/name, subdued argument payload. */
export function renderTranscriptToolCall(
  theme: Theme,
  name: string,
  argsPreview: string | undefined,
  width: number,
  state?: "running" | "done" | "error",
): string[] {
  if (width <= 0) return [];
  const safeName =
    sanitizeTerminalText(name).replaceAll("\n", " ").trim() || "tool";
  const marker = theme.fg("toolTitle", "▶ ");
  const suffix = state
    ? theme.fg(
        state === "error" ? "error" : state === "done" ? "success" : "warning",
        ` · ${state}`,
      )
    : "";
  const rows = [marker + theme.bold(theme.fg("toolTitle", safeName)) + suffix];
  const preview = sanitizeTerminalText(argsPreview ?? "").trim();
  if (preview && preview !== "{}") {
    const prefix = theme.fg("borderMuted", "  ");
    const wrapped = wrapTextWithAnsi(preview, Math.max(1, width - 2));
    rows.push(...wrapped.map((line) => prefix + theme.fg("dim", line)));
  }
  return bounded(rows, width);
}

/** Tool result treatment paired with, but quieter than, the invocation row. */
export function renderTranscriptToolResult(
  theme: Theme,
  output: string | undefined,
  width: number,
  isError = false,
): string[] {
  if (width <= 0) return [];
  const clean = sanitizeTerminalText(output ?? "").trim() || "(no output)";
  const label = isError ? "└ ✕ error" : "└ ✓ result";
  const color = isError ? "error" : "dim";
  const rows = [theme.fg(color, label)];
  const wrapped = wrapTextWithAnsi(clean, Math.max(1, width - 2));
  rows.push(...wrapped.map((line) => `  ${theme.fg(color, line)}`));
  return bounded(rows, width);
}
