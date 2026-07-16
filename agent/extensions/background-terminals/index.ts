import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  formatElapsed,
  terminalSummary,
  type TerminalSnapshot,
} from "./src/domain.ts";
import { BackgroundTerminalManager } from "./src/manager.ts";
import {
  BG_KILL_TOOL_DESCRIPTION,
  BG_LIST_TOOL_DESCRIPTION,
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_PROMPT_GUIDELINES,
  BG_START_PROMPT_SNIPPET,
  BG_START_TOOL_DESCRIPTION,
  BG_STATUS_TOOL_DESCRIPTION,
  buildKillReport,
  buildStartResult,
  buildStatusResult,
  buildTerminalResultMessage,
  describeTerminal,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  renderToolCallText,
  renderToolResultText,
} from "./src/ui/output-view.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";

const WIDGET_KEY = "background-terminals";
const RESULT_TYPE = "background-terminal-result";

type ToolName = "bg_start" | "bg_status" | "bg_list" | "bg_kill";

export default function backgroundTerminals(pi: ExtensionAPI): void {
  let manager: BackgroundTerminalManager | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let widgetCount = -1;
  const delivery = createDeferredResultDelivery<TerminalSnapshot>();

  const updateWidget = (): void => {
    if (!ui || !manager) return;
    const count = manager.view
      .list()
      .filter((snapshot) => snapshot.status === "running").length;
    if (count === widgetCount) return;
    widgetCount = count;
    try {
      if (count === 0) return ui.setWidget(WIDGET_KEY, undefined);
      ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
        render: () => [
          theme.fg("warning", "■ ") +
            theme.fg(
              "text",
              `${count} background terminal${count === 1 ? "" : "s"} running`,
            ) +
            theme.fg("dim", " • ") +
            theme.fg("accent", "/ps") +
            theme.fg("dim", " to view"),
        ],
        invalidate() {},
      }));
    } catch {
      // UI may already be unavailable during teardown.
    }
  };

  const flushResults = (): void => {
    for (const snapshot of delivery.drain()) {
      try {
        pi.sendMessage(
          {
            customType: RESULT_TYPE,
            content: buildTerminalResultMessage(snapshot),
            display: true,
            details: {
              summary: terminalSummary(snapshot),
              exitCode: snapshot.exitCode,
              signal: snapshot.signal,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        delivery.defer(snapshot);
      }
    }
  };

  const getManager = (): BackgroundTerminalManager => {
    if (manager) return manager;
    manager = new BackgroundTerminalManager();
    manager.view.setOnSettled((snapshot, consumed) => {
      if (consumed) return delivery.consume([snapshot.id]);
      delivery.defer({
        ...snapshot,
        stdout: { ...snapshot.stdout },
        stderr: { ...snapshot.stderr },
      });
      if (sessionContext?.isIdle()) flushResults();
    });
    unsubscribe = manager.view.subscribe(updateWidget);
    updateWidget();
    return manager;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
  });
  pi.on("agent_settled", flushResults);
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    delivery.clear();
    unsubscribe?.();
    unsubscribe = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* UI is shutting down. */
    }
    ui = undefined;
    widgetCount = -1;
    const closing = manager;
    manager = undefined;
    await closing?.disposeAll();
  });

  const renderers = (name: ToolName) => ({
    renderCall(args: object, theme: Theme, context: { expanded: boolean }) {
      return new Text(
        theme.fg(
          "toolTitle",
          renderToolCallText(
            name,
            args as Record<string, unknown>,
            context.expanded,
          ),
        ),
        0,
        0,
      );
    },
    renderResult(
      result: { content?: readonly unknown[]; details?: unknown },
      options: { expanded: boolean },
      theme: Theme,
    ) {
      return new Text(
        theme.fg("toolOutput", renderToolResultText(result, options.expanded)),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "bg_start",
    label: "Start Background Terminal",
    description: BG_START_TOOL_DESCRIPTION,
    promptSnippet: BG_START_PROMPT_SNIPPET,
    promptGuidelines: BG_START_PROMPT_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.command,
      }),
      title: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.title,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: BG_START_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted)
        throw new Error("Background terminal start aborted.");
      const command = params.command.trim();
      if (!command) throw new Error("command must not be empty.");
      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
        throw new Error(`working_dir is not a directory: ${cwd}`);
      const title =
        sanitizeTerminalText(params.title)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80) || "terminal";
      const snapshot = getManager().start({ command, title, cwd });
      return {
        content: [{ type: "text", text: buildStartResult(snapshot) }],
        details: {
          summary: terminalSummary(snapshot),
          id: snapshot.id,
          pid: snapshot.pid,
        },
      };
    },
    ...renderers("bg_start"),
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background Terminal Status",
    description: BG_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: "Terminal id, for example bt-1" }),
    }),
    async execute(_id, params) {
      const snapshot = getManager().status(params.id);
      if (snapshot.status !== "running") delivery.consume([snapshot.id]);
      return {
        content: [{ type: "text", text: buildStatusResult(snapshot) }],
        details: { summary: terminalSummary(snapshot) },
      };
    },
    ...renderers("bg_status"),
  });

  pi.registerTool({
    name: "bg_list",
    label: "List Background Terminals",
    description: BG_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const snapshots = getManager().list();
      return {
        content: [
          {
            type: "text",
            text: snapshots.length
              ? snapshots.map(describeTerminal).join("\n")
              : "No background terminals.",
          },
        ],
        details: { summaries: snapshots.map(terminalSummary) },
      };
    },
    ...renderers("bg_list"),
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Kill Background Terminals",
    description: BG_KILL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        description: "Terminal ids to stop",
      }),
    }),
    async execute(_id, params, signal) {
      const ids = [...new Set(params.ids)];
      const current = getManager();
      for (const id of ids) current.status(id);
      const results = await current.kill(ids, signal);
      delivery.consume(ids);
      const summaries = results.map((result) =>
        terminalSummary(current.status(result.id)),
      );
      return {
        content: [{ type: "text", text: buildKillReport(results) }],
        details: { summaries },
      };
    },
    ...renderers("bg_kill"),
  });

  pi.registerMessageRenderer(RESULT_TYPE, (message, { expanded }, theme) => {
    const details = message.details as
      { summary?: ReturnType<typeof terminalSummary> } | undefined;
    const summary = details?.summary;
    const collapsed = summary
      ? `${summary.title} · ${summary.id} · ${summary.status} · ${summary.elapsed}`
      : "background terminal completed";
    if (!expanded)
      return new Text(
        theme.fg(
          summary?.status === "failed" ? "error" : "success",
          sanitizeTerminalText(collapsed),
        ),
        0,
        0,
      );
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(
      theme.fg(
        "toolOutput",
        renderToolResultText(
          { content: [{ type: "text", text: content }], details },
          true,
        ),
      ),
      0,
      0,
    );
  });

  pi.registerCommand("ps", {
    description: "List and inspect background terminals",
    handler: async (_args, ctx) => {
      const current = getManager();
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            current.list().length
              ? current.list().map(describeTerminal).join("\n")
              : "No background terminals.",
            "info",
          );
        return;
      }
      if (current.view.size() === 0) {
        ctx.ui.notify(
          "No background terminals yet. The agent starts them with bg_start.",
          "info",
        );
        return;
      }
      await openTerminalPicker(ctx, current.view);
    },
  });
}
