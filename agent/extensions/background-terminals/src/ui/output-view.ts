import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import type { TerminalSummary } from "../domain.ts";

export const RENDER_MAX_BYTES = 24 * 1024;
export const RENDER_MAX_LINES = 500;

export function oneLine(text: string): string {
  return sanitizeTerminalText(text).replaceAll("\n", " ").trim();
}

export function buildOutputLines(rawText: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const safe = sanitizeTerminalText(rawText);
  const lines: string[] = [];
  for (const line of safe.split("\n")) {
    if (!line) lines.push("");
    else lines.push(...wrapTextWithAnsi(line, safeWidth));
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function createOutputLineCache() {
  let version = -1;
  let width = -1;
  let lines: string[] = [];
  return {
    get(rawText: string, nextVersion: number, nextWidth: number): string[] {
      if (version !== nextVersion || width !== nextWidth) {
        version = nextVersion;
        width = nextWidth;
        lines = buildOutputLines(rawText, nextWidth);
      }
      return lines;
    },
    clear(): void {
      version = -1;
      width = -1;
      lines = [];
    },
  };
}

function textContent(result: { content?: readonly unknown[] }): string {
  return (result.content ?? [])
    .map((item) =>
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text"
        ? String((item as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function boundedSanitizedRendererOutput(text: string): string {
  return truncateTail(sanitizeTerminalText(text), {
    maxBytes: Math.min(RENDER_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxLines: Math.min(RENDER_MAX_LINES, DEFAULT_MAX_LINES),
  }).content;
}

export interface BackgroundToolDetails {
  summary?: TerminalSummary;
  summaries?: readonly TerminalSummary[];
}

/** Collapsed result rows intentionally expose only title/id/state/elapsed. */
export function collapsedToolResult(
  details: BackgroundToolDetails | undefined,
): string {
  const summaries =
    details?.summaries ?? (details?.summary ? [details.summary] : []);
  return summaries
    .map(
      (summary) =>
        `${oneLine(summary.title)} · ${oneLine(summary.id)} · ${oneLine(summary.status)} · ${oneLine(summary.elapsed)}`,
    )
    .join("\n");
}

export function renderToolCallText(
  name: "bg_start" | "bg_status" | "bg_list" | "bg_kill",
  args: Record<string, unknown>,
  expanded: boolean,
): string {
  if (name === "bg_start") {
    const title = oneLine(String(args.title ?? "terminal"));
    return expanded
      ? `bg_start · ${title}\n${boundedSanitizedRendererOutput(String(args.command ?? ""))}`
      : `bg_start · ${title}`;
  }
  if (name === "bg_status")
    return `bg_status · ${oneLine(String(args.id ?? "?"))}`;
  if (name === "bg_kill") {
    const ids = Array.isArray(args.ids)
      ? args.ids.map((id) => oneLine(String(id))).join(", ")
      : "?";
    return `bg_kill · ${ids}`;
  }
  return "bg_list";
}

export function renderToolResultText(
  result: { content?: readonly unknown[]; details?: unknown },
  expanded: boolean,
): string {
  const details = result.details as BackgroundToolDetails | undefined;
  const collapsed = collapsedToolResult(details);
  if (!expanded) return collapsed || "background terminal";
  const output = boundedSanitizedRendererOutput(textContent(result));
  return [collapsed, output].filter(Boolean).join("\n");
}
