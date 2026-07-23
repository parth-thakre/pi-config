/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  closedToolFrameText,
  closedToolFrameTop,
  toolFrameStatus,
} from "../shared/closed-tool-frame.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type SelectionResult = {
  answer: string;
  wasCustom: boolean;
  index?: number;
} | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        text: string,
        answer: string | null = null,
        wasCustom = false,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer,
          wasCustom,
          cancelled: answer === null,
        } satisfies AskUserDetails,
      });

      if (
        params.options.length < MIN_OPTIONS ||
        params.options.length > MAX_OPTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const allOptions: DisplayOption[] = [
        ...params.options,
        { label: "Write my own answer…", isOther: true },
      ];

      const showQuestion = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          let optionIndex = 0;
          let editMode = false;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;

          let settled = false;

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              finish({ answer: trimmed, wasCustom: true });
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function refresh() {
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          }

          function selectOption(index: number) {
            const selected = allOptions[index];
            if (selected.isOther) {
              optionIndex = index;
              editMode = true;
              refresh();
            } else {
              finish({
                answer: selected.label,
                wasCustom: false,
                index: index + 1,
              });
            }
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              optionIndex =
                (optionIndex - 1 + allOptions.length) % allOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = (optionIndex + 1) % allOptions.length;
              refresh();
              return;
            }

            // Number keys jump straight to an option
            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(allOptions.length)
            ) {
              selectOption(Number(data) - 1);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }

            if (matchesKey(data, Key.escape)) {
              finish(null);
            }
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            if (width < 3) return [theme.fg("accent", "─".repeat(width))];

            const innerWidth = width - 2;
            const edge = (text: string) => theme.fg("accent", text);
            const lines: string[] = [];
            const add = (content = "") => {
              const fitted = truncateToWidth(content, innerWidth, "");
              const fill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(fitted)),
              );
              lines.push(`${edge("│")}${fitted}${fill}${edge("│")}`);
            };

            const title = " Question ";
            const topFill = "─".repeat(
              Math.max(0, innerWidth - title.length - 1),
            );
            lines.push(edge(`╭─${title}${topFill}╮`));
            for (const line of wrapText(
              params.question,
              Math.max(10, innerWidth - 2),
            )) {
              add(` ${theme.fg("text", theme.bold(line))}`);
            }
            add();

            for (let i = 0; i < allOptions.length; i++) {
              const opt = allOptions[i];
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
              const marker = opt.isOther ? "✎" : `${i + 1}.`;
              const label = `${marker} ${opt.label}`;

              if (selected || (opt.isOther && editMode)) {
                add(prefix + theme.fg("accent", label));
              } else {
                add(prefix + theme.fg(opt.isOther ? "muted" : "text", label));
              }

              if (opt.description) {
                add(`      ${theme.fg("muted", opt.description)}`);
              }
            }

            if (editMode) {
              add();
              add(theme.fg("muted", " Your answer:"));
              const editorBoxWidth = Math.max(3, innerWidth - 2);
              const editorLines = editor.render(
                Math.max(1, editorBoxWidth - 2),
              );
              for (let index = 0; index < editorLines.length; index++) {
                const line = editorLines[index];
                const fill = " ".repeat(
                  Math.max(0, editorBoxWidth - 2 - visibleWidth(line)),
                );
                const left =
                  index === 0
                    ? "╭"
                    : index === editorLines.length - 1
                      ? "╰"
                      : "│";
                const right =
                  index === 0
                    ? "╮"
                    : index === editorLines.length - 1
                      ? "╯"
                      : "│";
                add(` ${edge(left)}${line}${fill}${edge(right)}`);
              }
            }

            add();
            if (editMode) {
              add(theme.fg("dim", " Enter submit • Esc back to options"));
            } else {
              add(
                theme.fg(
                  "dim",
                  ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
                ),
              );
            }
            lines.push(edge(`╰${"─".repeat(innerWidth)}╯`));

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedWidth = undefined;
              cachedLines = undefined;
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestion),
        signal ? { signal } : undefined,
      );

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;

      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      if (result.wasCustom) {
        return reply(
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          result.answer,
          true,
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: result.index,
        }),
        result.answer,
      );
    },

    renderShell: "self",

    renderCall(args, theme, context) {
      const title =
        theme.fg("toolTitle", theme.bold("ask_user ")) +
        theme.fg(
          "muted",
          typeof args.question === "string" ? args.question : "",
        );
      const opts = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      const rows = opts.map((option, index) =>
        theme.fg("dim", ` ${index + 1}. ${option.label}`),
      );
      return closedToolFrameTop(title, toolFrameStatus(context), theme, rows);
    },

    renderResult(result, _options, theme, context) {
      const status = toolFrameStatus(context);
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return closedToolFrameText(
          first?.type === "text" ? first.text : "",
          status,
          theme,
        );
      }

      if (details.cancelled || details.answer === null) {
        return closedToolFrameText(
          theme.fg("warning", "✗ dismissed"),
          status,
          theme,
          theme.fg("warning", "dismissed"),
        );
      }

      if (details.wasCustom) {
        return closedToolFrameText(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          status,
          theme,
          theme.fg("success", "answered"),
        );
      }

      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return closedToolFrameText(
        theme.fg("success", "✓ ") + theme.fg("accent", display),
        status,
        theme,
        theme.fg("success", "answered"),
      );
    },
  });
}
