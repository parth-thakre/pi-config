import {
  formatSize,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatElapsed, formatExit, type TerminalSnapshot } from "../domain.ts";
import type { TerminalReadModel } from "../manager.ts";
import { createOutputLineCache, oneLine } from "./output-view.ts";

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  terminals: readonly Pick<TerminalSnapshot, "id">[],
): void {
  const byId = selection.id
    ? terminals.findIndex((terminal) => terminal.id === selection.id)
    : -1;
  selection.index =
    byId >= 0
      ? byId
      : Math.min(
          Math.max(0, selection.index),
          Math.max(0, terminals.length - 1),
        );
  selection.id = terminals[selection.index]?.id;
}

function keys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function glyph(snapshot: TerminalSnapshot, theme: Theme): string {
  const color =
    snapshot.status === "running"
      ? "warning"
      : snapshot.status === "done"
        ? "success"
        : snapshot.status === "failed"
          ? "error"
          : "muted";
  return theme.fg(color, "■");
}

function split(left: string, right: string, width: number): string {
  const clippedRight = truncateToWidth(right, Math.max(0, width), "");
  const rightWidth = visibleWidth(clippedRight);
  const clippedLeft = truncateToWidth(
    left,
    Math.max(0, width - rightWidth - 1),
    "…",
  );
  const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
  return truncateToWidth(
    `${clippedLeft}${" ".repeat(gap)}${clippedRight}`,
    width,
    "",
  );
}

abstract class LiveComponent implements Component {
  protected closed = false;
  protected readonly tui: TUI;
  protected readonly ticker: ReturnType<typeof setInterval>;
  protected readonly unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  constructor(
    tui: TUI,
    subscribe: (listener: () => void) => () => void,
    debounceMs = 0,
  ) {
    this.tui = tui;
    this.ticker = setInterval(() => tui.requestRender(), 1000);
    this.unsubscribe = subscribe(() => {
      if (debounceMs === 0) return tui.requestRender();
      if (this.renderTimer) return;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = undefined;
        if (!this.closed) tui.requestRender();
      }, debounceMs);
    });
  }
  dispose(): void {
    this.cleanup();
  }
  protected cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.unsubscribe();
  }
  invalidate(): void {}
  abstract render(width: number): string[];
  abstract handleInput(data: string): void;
}

class TerminalDashboard extends LiveComponent {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly view: TerminalReadModel;
  private readonly selection: DashboardSelection;
  private readonly done: (id: string | null) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: TerminalReadModel,
    selection: DashboardSelection,
    done: (id: string | null) => void,
  ) {
    super(tui, (listener) => view.subscribe(listener));
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
  }

  private close(id: string | null): void {
    this.cleanup();
    this.done(id);
  }

  handleInput(data: string): void {
    const terminals = this.view.list();
    reconcileDashboardSelection(this.selection, terminals);
    if (this.keybindings.matches(data, "tui.select.cancel"))
      return this.close(null);
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = terminals[this.selection.index];
      if (selected) this.close(selected.id);
      return;
    }
    const delta =
      this.keybindings.matches(data, "tui.select.up") || data === "k"
        ? -1
        : this.keybindings.matches(data, "tui.select.down") || data === "j"
          ? 1
          : 0;
    if (delta && terminals.length > 0) {
      this.selection.index =
        (this.selection.index + delta + terminals.length) % terminals.length;
      this.selection.id = terminals[this.selection.index]?.id;
      this.tui.requestRender();
    } else if (data === "x") {
      const selected = terminals[this.selection.index];
      if (selected?.status === "running") this.view.requestKill(selected.id);
    }
  }

  render(width: number): string[] {
    const terminals = this.view.list();
    reconcileDashboardSelection(this.selection, terminals);
    const height = Math.max(5, (this.tui.terminal.rows || 30) - 5);
    const start = Math.max(
      0,
      Math.min(
        this.selection.index - Math.floor(height / 2),
        terminals.length - height,
      ),
    );
    const lines = [
      split(
        ` ${this.theme.bold(this.theme.fg("accent", "Background terminals"))}`,
        this.theme.fg(
          "dim",
          `${terminals.filter((item) => item.status === "running").length} running · ${terminals.length} total `,
        ),
        width,
      ),
    ];
    lines.push(
      this.theme.fg("borderMuted", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
    );
    for (let row = 0; row < height; row++) {
      const index = start + row;
      const snapshot = terminals[index];
      let content = "";
      if (snapshot) {
        const selected = index === this.selection.index;
        const left = ` ${selected ? this.theme.fg("accent", "❯") : " "} ${glyph(snapshot, this.theme)} ${selected ? this.theme.fg("accent", oneLine(snapshot.title)) : oneLine(snapshot.title)} ${this.theme.fg("dim", snapshot.id)}`;
        const right = this.theme.fg(
          "dim",
          `pid ${snapshot.pid ?? "?"} · ${formatElapsed(snapshot)} · ${formatExit(snapshot)} `,
        );
        content = split(left, right, Math.max(0, width - 2));
      }
      const padding = Math.max(0, width - 2 - visibleWidth(content));
      lines.push(
        `${this.theme.fg("borderMuted", "│")}${content}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`,
      );
    }
    lines.push(
      this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    );
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          ` ${keys(this.keybindings, "tui.select.up")}/${keys(this.keybindings, "tui.select.down")}/jk select · enter inspect · x kill · esc close`,
        ),
        width,
        "",
      ),
    );
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

class TerminalDetail extends LiveComponent {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly id: string;
  private readonly view: TerminalReadModel;
  private readonly done: () => void;
  private stream: "stdout" | "stderr" = "stdout";
  private offset = 0;
  private previousRows = 0;
  private cache = createOutputLineCache();

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: TerminalReadModel,
    done: () => void,
  ) {
    super(tui, (listener) => view.subscribeTo(id, listener), 50);
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
  }

  private close(): void {
    this.cleanup();
    this.done();
  }
  private viewport(): number {
    return Math.max(5, (this.tui.terminal.rows || 30) - 10);
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "app.interrupt")
    )
      return this.close();
    if (data === "t") {
      this.stream = this.stream === "stdout" ? "stderr" : "stdout";
      this.offset = 0;
      this.previousRows = 0;
      this.cache.clear();
    } else if (data === "x") {
      const snapshot = this.view.get(this.id);
      if (snapshot?.status === "running") this.view.requestKill(this.id);
    } else if (
      this.keybindings.matches(data, "tui.editor.cursorUp") ||
      data === "k"
    )
      this.offset += 6;
    else if (
      this.keybindings.matches(data, "tui.editor.cursorDown") ||
      data === "j"
    )
      this.offset = Math.max(0, this.offset - 6);
    else if (this.keybindings.matches(data, "tui.editor.pageUp"))
      this.offset += this.viewport();
    else if (this.keybindings.matches(data, "tui.editor.pageDown"))
      this.offset = Math.max(0, this.offset - this.viewport());
    else if (data === "g") this.offset = Number.MAX_SAFE_INTEGER;
    else if (data === "G") this.offset = 0;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const snapshot = this.view.get(this.id);
    if (!snapshot)
      return [
        truncateToWidth(
          this.theme.fg("dim", `${this.id} is no longer tracked`),
          width,
          "",
        ),
      ];
    const border = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
    const active = this.stream === "stdout" ? snapshot.stdout : snapshot.stderr;
    const rows = this.cache.get(
      active.text,
      active.totalBytes,
      Math.max(1, width - 2),
    );
    if (
      this.offset > 0 &&
      this.previousRows > 0 &&
      rows.length > this.previousRows
    )
      this.offset += rows.length - this.previousRows;
    this.previousRows = rows.length;
    const notes: string[] = [];
    if (active.truncatedBytes > 0)
      notes.push(
        this.theme.fg(
          "dim",
          `${formatSize(active.truncatedBytes)} dropped from memory tail`,
        ),
      );
    notes.push(
      this.theme.fg(
        "dim",
        `spill ${oneLine(active.spillDirectory ?? "unavailable")} · ${active.spillFiles.length} files · ${active.spillRotations} rotations · ${formatSize(active.spillDroppedBytes)} rotated out${active.spillError ? ` · incomplete: ${oneLine(active.spillError)}` : ""}`,
      ),
    );
    const viewport = this.viewport();
    const capacity = Math.max(
      1,
      viewport - notes.length - (this.offset > 0 ? 1 : 0),
    );
    const maxOffset = Math.max(0, rows.length - capacity);
    this.offset = Math.min(this.offset, maxOffset);
    const end = rows.length - this.offset;
    const visible = rows.slice(Math.max(0, end - capacity), end);
    const lines = [
      border,
      truncateToWidth(
        `${glyph(snapshot, this.theme)} ${this.theme.bold(this.theme.fg("accent", `${snapshot.id} · ${oneLine(snapshot.title)}`))}${this.theme.fg("dim", ` · ${snapshot.status} · ${formatElapsed(snapshot)} · pid ${snapshot.pid ?? "?"} · ${oneLine(snapshot.cwd)}`)}`,
        width,
        "",
      ),
      truncateToWidth(
        `${this.theme.fg("dim", "> ")}${oneLine(snapshot.command)}`,
        width,
        "",
      ),
      border,
      truncateToWidth(
        ` ${this.stream === "stdout" ? this.theme.fg("accent", this.theme.bold(`stdout ${formatSize(snapshot.stdout.totalBytes)}`)) : this.theme.fg("dim", `stdout ${formatSize(snapshot.stdout.totalBytes)}`)} ${this.theme.fg("dim", "│")} ${this.stream === "stderr" ? this.theme.fg("accent", this.theme.bold(`stderr ${formatSize(snapshot.stderr.totalBytes)}`)) : this.theme.fg("dim", `stderr ${formatSize(snapshot.stderr.totalBytes)}`)}`,
        width,
        "",
      ),
      ...notes.map((note) => truncateToWidth(` ${note}`, width, "")),
      ...(visible.length
        ? visible.map((line) => truncateToWidth(` ${line}`, width, ""))
        : [this.theme.fg("dim", ` (no ${this.stream} yet)`)]),
    ];
    if (this.offset > 0)
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", ` … ${this.offset} lines below`),
          width,
          "",
        ),
      );
    while (lines.length < viewport + 5) lines.push("");
    lines.push(border);
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          " esc back · t stdout/stderr · x kill · j/k scroll · pgup/pgdn page · g/G top/bottom",
        ),
        width,
        "",
      ),
    );
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export async function openTerminalPicker(
  ctx: ExtensionCommandContext,
  view: TerminalReadModel,
): Promise<void> {
  const selection: DashboardSelection = { index: 0 };
  while (view.size() > 0) {
    const id = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new TerminalDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (!id) return;
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new TerminalDetail(tui, theme, keybindings, id, view, () =>
          done(undefined),
        ),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
  }
}
