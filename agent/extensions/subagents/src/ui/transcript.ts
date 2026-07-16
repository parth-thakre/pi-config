/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into plain wrapped lines. Ported from
 * v1, with the session-poking replaced by snapshot reads.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import {
  renderAssistantMarkdown,
  renderReasoningTrace,
  renderTranscriptToolCall,
  renderTranscriptToolResult,
  renderTranscriptUser,
} from "../../../shared/transcript-rendering.ts";
import type { SubagentSnapshot, TranscriptItem } from "../domain.ts";

function renderUserText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  out.push(...renderTranscriptUser(theme, text, width));
}

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
  showLabel = true,
) {
  out.push(
    ...renderReasoningTrace(theme, text, width, {
      showLabel,
    }),
  );
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  width: number,
  out: string[],
  showReasoningLabel = true,
) {
  let reasoningChunks: string[] = [];
  let labelAvailable = showReasoningLabel;
  const flushReasoning = () => {
    if (reasoningChunks.length === 0) return;
    renderThinking(
      theme,
      reasoningChunks.join("\n\n"),
      width,
      out,
      labelAvailable,
    );
    reasoningChunks = [];
    labelAvailable = false;
  };

  for (const part of item.parts) {
    if (part.type === "thinking") {
      reasoningChunks.push(part.redacted ? "[redacted reasoning]" : part.text);
      continue;
    }
    flushReasoning();
    labelAvailable = true;
    if (part.type === "text") {
      out.push(...renderAssistantMarkdown(theme, part.text, width));
    } else if (part.type === "toolCall") {
      out.push(
        ...renderTranscriptToolCall(theme, part.name, part.argsPreview, width),
      );
    }
  }
  flushReasoning();
}

function isThinkingOnly(
  item: TranscriptItem,
): item is Extract<TranscriptItem, { kind: "assistant" }> {
  return (
    item.kind === "assistant" &&
    item.parts.length > 0 &&
    item.parts.every((part) => part.type === "thinking")
  );
}

function renderToolResultItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "toolResult" }>,
  width: number,
  out: string[],
) {
  out.push(
    ...renderTranscriptToolResult(
      theme,
      item.outputPreview,
      width,
      item.isError,
    ),
  );
}

/** Render a subagent's conversation as plain lines, wrapped to `width`. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = [];
  let previousThinkingOnly = false;

  for (const item of snap.transcript) {
    const thinkingOnly = isThinkingOnly(item);
    if (thinkingOnly && previousThinkingOnly && out.at(-1) === "") out.pop();
    const before = out.length;
    if (item.kind === "user") {
      renderUserText(theme, item.text, width, out);
    } else if (item.kind === "assistant") {
      renderAssistantItem(theme, item, width, out, !previousThinkingOnly);
    } else {
      renderToolResultItem(theme, item, width, out);
    }
    if (out.length > before) out.push("");
    previousThinkingOnly = thinkingOnly;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // Live streaming assistant buffers (cleared when the finalized message lands).
  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    const cleanThinking = sanitizeTerminalText(thinking).trim();
    const cleanText = sanitizeTerminalText(text).trim();
    const continuesReasoning =
      previousThinkingOnly && cleanThinking && !cleanText;
    if (out.length > 0 && !continuesReasoning) out.push("");
    if (cleanThinking)
      renderThinking(theme, cleanThinking, width, out, !continuesReasoning);
    if (cleanText)
      out.push(...renderAssistantMarkdown(theme, cleanText, width));
    if (out.length === before + 1) out.pop();
  }

  // Live tool executions (present until the ToolEnd lands in the transcript).
  for (const tool of snap.liveTools) {
    if (out.length > 0) out.push("");
    out.push(
      ...renderTranscriptToolCall(
        theme,
        tool.name,
        tool.outputPreview,
        width,
        tool.done ? (tool.isError ? "error" : "done") : "running",
      ),
    );
  }

  // Queued steering/follow-up messages: show them immediately so Enter
  // visibly acknowledges the user's input instead of appearing to do nothing.
  for (const message of snap.queued) {
    if (out.length > 0) out.push("");
    const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeTerminalText(message.text),
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }

  return out;
}
