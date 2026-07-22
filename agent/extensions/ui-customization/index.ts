/**
 * ui-customization — boxed editor, custom footer, and window title.
 *
 * Adapted from davis7dotsh/my-pi-setup: his version also renders a gradient
 * ASCII header, but that is dropped here — flow-title.ts owns the header
 * (trans-pride gradient). This extension only owns:
 *   - the editor: a complete box instead of standalone horizontal rules
 *   - the footer: directory + model on line 1, usage (context/cost/tok/s)
 *     + git summary on line 2, then extension statuses
 *   - the terminal window title ("pi · <dir>")
 *
 * Data is pushed over shared event channels: model-info publishes
 * MODEL_INFO_CHANNEL; git-info (not installed) would publish
 * GIT_INFO_CHANNEL — the git half of the footer simply stays empty until
 * that extension is added. REFRESH_CHANNEL is emitted on install so data
 * providers repaint immediately.
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../shared/dashboard-state.ts";

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
    return `~/${relative(home, cwd)}`;
  }
  return cwd;
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HORIZONTAL_BORDER = /^─+(?: [↑↓] \d+ more ─*)?$/;

class BoxedEditor extends CustomEditor {
  render(width: number): string[] {
    if (width < 3) return super.render(width);

    const innerWidth = width - 2;
    const lines = super.render(innerWidth);
    const bottomBorder = lines.findIndex(
      (line, index) =>
        index > 0 && HORIZONTAL_BORDER.test(line.replace(ANSI_ESCAPE, "")),
    );

    return lines.map((line, index) => {
      if (index === 0) {
        return `${this.borderColor("╭")}${line}${this.borderColor("╮")}`;
      }
      if (index === bottomBorder) {
        return `${this.borderColor("╰")}${line}${this.borderColor("╯")}`;
      }
      if (bottomBorder < 0 || index < bottomBorder) {
        return `${this.borderColor("│")}${line}${this.borderColor("│")}`;
      }

      // Autocomplete remains visually attached below the input box.
      return ` ${line} `;
    });
  }
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
          let git = gitInfo.branch
            ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel} changed`
            : "";

          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            git += ` · ${linkedPr}`;
          }

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const contextWindow =
            modelInfo.contextWindow > 0
              ? formatTokens(modelInfo.contextWindow)
              : "?";
          const tps =
            modelInfo.tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
          const usage = `${contextPercent}%/${contextWindow} · $${modelInfo.cost.toFixed(2)} · ${tps}`;
          const model = modelInfo.provider
            ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
            : modelInfo.modelId;

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), theme.fg("muted", git), width),
          ];

          // Extension statuses render after the two dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new BoxedEditor(tui, theme, keybindings, { paddingX: 1 }),
    );
    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
