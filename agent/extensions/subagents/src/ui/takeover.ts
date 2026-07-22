/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: full popup (overlay) listing all subagents.
 * - TakeoverView: full interactive view of one subagent with an input line
 *   to steer/continue it.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines } from "./transcript.ts";

function displayLine(value: unknown) {
  return sanitizeTerminalText(
    typeof value === "string" ? value : String(value ?? ""),
  ).replaceAll("\n", " ");
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

function composeSubagentPanel(
  theme: Theme,
  title: string,
  rows: readonly string[],
  width: number,
  height: number,
  focused = false,
): string[] {
  const panelWidth = Math.max(0, width);
  const panelHeight = Math.max(0, height);
  if (panelHeight === 0) return [];
  if (panelWidth === 0) return Array.from({ length: panelHeight }, () => "");

  const border = (text: string) =>
    theme.fg(focused ? "borderAccent" : "borderMuted", text);
  if (panelWidth === 1) {
    return Array.from({ length: panelHeight }, (_, index) =>
      border(index === 0 ? "╭" : index === panelHeight - 1 ? "╰" : "│"),
    );
  }

  const innerWidth = panelWidth - 2;
  const safeTitle = displayLine(title);
  const rawTitle = truncateToWidth(safeTitle, Math.max(0, innerWidth - 3), "");
  const titleText = rawTitle
    ? ` ${theme.bold(theme.fg(focused ? "accent" : "text", rawTitle))} `
    : "";
  const topFill = Math.max(0, innerWidth - 1 - visibleWidth(titleText));
  const lines = [border("╭─") + titleText + border(`${"─".repeat(topFill)}╮`)];

  const bodyHeight = Math.max(0, panelHeight - 2);
  for (let index = 0; index < bodyHeight; index++) {
    const row = truncateToWidth(rows[index] ?? "", innerWidth, "…");
    lines.push(
      border("│") +
        row +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(row))) +
        border("│"),
    );
  }
  if (panelHeight > 1) lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return lines.slice(0, panelHeight);
}

// --- Entry point ---------------------------------------------------------------

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TakeoverView(tui, theme, keybindings, picked, view, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private done: (value: string | null) => void;

  private selected = 0;
  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.done = done;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list();
  }

  private clampSelection() {
    const count = this.subs().length;
    if (this.selected >= count) this.selected = Math.max(0, count - 1);
    if (this.selected < 0) this.selected = 0;
  }

  private close(result: string | null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    this.done(result);
  }

  handleInput(data: string): void {
    this.clampSelection();
    const subs = this.subs();

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selected];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selected = (this.selected - 1 + subs.length) % subs.length;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selected = (this.selected + 1) % subs.length;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selected];
      if (snap && snap.status === "running") this.view.requestAbort(snap.id);
      return;
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    this.clampSelection();
    const subs = this.subs();

    const rows = this.tui.terminal.rows || 30;
    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Subagents"));
    const headerRight = theme.fg(
      "muted",
      `${subs.length} agent${subs.length === 1 ? "" : "s"}`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    const settled = subs.filter((s) => s.status !== "running").length;
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
    lines.push(
      ...composeSubagentPanel(
        theme,
        `Agents · ${settled}/${subs.length}`,
        rowLines,
        width,
        bodyHeight + 2,
        true,
      ),
    );

    // Hints
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} take over · x abort · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (subs.length > height) {
      start = Math.min(
        Math.max(0, this.selected - Math.floor(height / 2)),
        subs.length - height,
      );
    }
    const visible = subs.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selected;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const displayTitle = displayLine(snap.title);
      const displayId = displayLine(snap.id);
      const title = isSelected
        ? theme.fg("accent", displayTitle)
        : theme.fg("text", displayTitle);
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", displayId)}`;

      // Right: backend · model · context utilization · elapsed · status
      const utilization = formatContextUtilization(snap.usage);
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", displayLine(snap.backend)),
        theme.fg("muted", displayLine(snap.meta.modelLabel ?? "?")),
        ...(utilization ? [theme.fg("muted", utilization)] : []),
        theme.fg("muted", formatElapsed(snap)),
        statusWord(snap, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < subs.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${subs.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

const TRANSCRIPT_SCROLL_STEP = 6;

class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.done(null);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // The complete view renders viewport + 7 chrome rows. Using rows - 8
    // makes the overlay exactly terminal rows - 1.
    return Math.max(6, rows - 8);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      return composeSubagentPanel(
        theme,
        "Subagent",
        [theme.fg("dim", `${displayLine(this.id)} is no longer tracked`)],
        width,
        3,
        true,
      );
    }

    const innerWidth = Math.max(0, width - 2);
    const utilization = formatContextUtilization(snap.usage);
    const metadata =
      ` ${statusGlyph(snap, theme)} ` +
      theme.fg("muted", `${snap.status} · ${formatElapsed(snap)}`) +
      theme.fg(
        "dim",
        ` · ${displayLine(snap.backend)}: ${displayLine(snap.meta.modelLabel ?? "?")}`,
      ) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "");

    // Error and scroll status consume rows inside the fixed transcript panel,
    // keeping the overlay stable while the subagent streams.
    const transcript = buildTranscriptLines(snap, innerWidth, theme);
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(
          theme.fg("error", ` error: ${displayLine(snap.errorText)}`),
          innerWidth,
        ),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) body.push(theme.fg("dim", " (no output yet)"));
    else body.push(...visible);

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", ` ... ${this.scrollOffset} lines below · ↓/pgdn`),
          innerWidth,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(
      ...composeSubagentPanel(
        theme,
        `${displayLine(snap.id)} · ${displayLine(snap.title)}`,
        [metadata, ...body.slice(0, viewport)],
        width,
        viewport + 3,
        true,
      ),
    );

    const inputLines = this.input.render(innerWidth);
    lines.push(
      ...composeSubagentPanel(
        theme,
        snap.status === "running" ? "Message subagent" : "Continue subagent",
        inputLines,
        width,
        inputLines.length + 2,
        true,
      ),
    );
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          ` ${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page`,
        ),
        width,
      ),
    );
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
