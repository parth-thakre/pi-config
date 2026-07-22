import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const RESET = "\x1b[0m";
type RGB = [number, number, number];

const BLUE: RGB = [91, 206, 250];
const PINK: RGB = [245, 169, 184];
const WHITE: RGB = [255, 255, 255];
const MUTED: RGB = [142, 148, 170];

// Capital Π — top bar has upside-down pixel steps (narrow at top, widens each row).
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

function fg([r, g, b]: RGB, text: string) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Per-character gradient — spaces are skipped, gradient maps only over
// visible (non-space) characters so the legs get the edge colours.
const TRANS: RGB[] = [BLUE, PINK, WHITE, PINK, BLUE];

function gradientText(text: string) {
  const chars = [...text];
  const visible = chars.filter((ch) => ch !== " ").length;
  if (visible === 0) return text;

  const segments = TRANS.length - 1;
  const colored: string[] = [];
  let vi = 0;

  for (const ch of chars) {
    if (ch === " ") {
      colored.push(ch);
      continue;
    }
    const p = vi / Math.max(visible - 1, 1);
    const scaled = p * segments;
    const idx = Math.min(Math.floor(scaled), TRANS.length - 2);
    const color = mix(TRANS[idx], TRANS[idx + 1], scaled - idx);
    colored.push(fg(color, ch));
    vi++;
  }

  return colored.join("");
}

function modelName(ctx: ExtensionContext) {
  const m = ctx.model as { id?: string } | undefined;
  const id = m?.id ?? "";
  if (!id) return "pi";
  return id.replace(/[_-]+/g, " ").toUpperCase();
}

function providerName(ctx: ExtensionContext) {
  const m = ctx.model as { provider?: string } | undefined;
  return m?.provider ?? "";
}

const AGENT_DIR = join(homedir(), ".pi", "agent");

function listDirNames(
  path: string,
  include: (entry: string, fullPath: string) => boolean,
) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => {
        const fullPath = join(path, entry.name);
        return include(entry.name, fullPath) ? entry.name : undefined;
      })
      .filter((name): name is string => Boolean(name))
      .map((name) => name.replace(/\.(ts|js|mjs|json)$/i, ""))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function dynamicExtensions() {
  return listDirNames(join(AGENT_DIR, "extensions"), (name, fullPath) => {
    const ext = extname(name).toLowerCase();
    return (
      [".ts", ".js"].includes(ext) ||
      existsSync(join(fullPath, "index.ts")) ||
      existsSync(join(fullPath, "index.js"))
    );
  }).filter(
    (name) => name !== "flow-title" && name !== "ui-customization",
  );
}

function dynamicThemes() {
  return listDirNames(
    join(AGENT_DIR, "themes"),
    (name) => extname(name).toLowerCase() === ".json",
  );
}

function dynamicSkills() {
  return listDirNames(join(AGENT_DIR, "skills"), (_name, fullPath) =>
    existsSync(join(fullPath, "SKILL.md")),
  );
}

interface PillRow {
  label: string;
  color: RGB;
  items: string[];
}

// Left-aligned rows: labels share a fixed gutter and long item lists wrap
// onto continuation lines aligned with the first item.
function pillLines(rows: PillRow[], itemsWidth: number): string[] {
  itemsWidth = Math.max(24, itemsWidth);
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const lines: string[] = [];

  for (const { label, color, items } of rows) {
    const shown = items.length ? items : ["none"];
    const wrapped: string[] = [""];
    for (const item of shown) {
      const current = wrapped[wrapped.length - 1];
      const candidate = current ? `${current}  ${item}` : item;
      if (current && visibleWidth(candidate) > itemsWidth) {
        wrapped.push(item);
      } else {
        wrapped[wrapped.length - 1] = candidate;
      }
    }
    wrapped.forEach((line, index) => {
      const gutter =
        index === 0
          ? fg(color, label.padEnd(labelWidth))
          : " ".repeat(labelWidth);
      lines.push(`${gutter}  ${fg(MUTED, line)}`);
    });
  }

  return lines;
}

const MARGIN = 2;
const ART_GAP = 4;
const ART_WIDTH = Math.max(...TITLE_LINES.map((line) => visibleWidth(line)));
// Pills sit beside the logo, starting on its second row.
const PILL_ROW_OFFSET = 1;

// Vertical trans stripes for the frame's side bars (top to bottom).
function stripeColor(index: number, total: number): RGB {
  if (total <= 1) return TRANS[0];
  const scaled = (index / (total - 1)) * (TRANS.length - 1);
  const i = Math.min(Math.floor(scaled), TRANS.length - 2);
  return mix(TRANS[i], TRANS[i + 1], scaled - i);
}

// Full-width rounded box: trans gradient edges, vertical flag stripes down
// the sides, and the heading embedded in the bottom edge like a plaque.
function frame(lines: string[], width: number, heading: string): string[] {
  const total = lines.length + 2;
  const headingWidth = visibleWidth(heading);
  const top = gradientText("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
  const bottom =
    gradientText("╰─ ") +
    heading +
    gradientText(" " + "─".repeat(Math.max(1, width - 5 - headingWidth)) + "╯");

  const framed = lines.map((line, index) => {
    const bar = fg(stripeColor(index + 1, total - 1), "│");
    const pad = Math.max(0, width - 4 - visibleWidth(line));
    return `${bar} ${truncateToWidth(line, width - 4, "")}${" ".repeat(pad)} ${bar}`;
  });

  // TUI can briefly request extremely narrow widths during layout. The frame
  // decorations themselves have a minimum natural width, so bound every final
  // line rather than relying on the individual content budgets above.
  return [top, ...framed, bottom].map((line) =>
    truncateToWidth(line, Math.max(0, width), ""),
  );
}

export function renderHeader(width: number, ctx: ExtensionContext): string[] {
  const provider = providerName(ctx);
  const margin = " ".repeat(MARGIN);
  const pillIndent = MARGIN + ART_WIDTH + ART_GAP;
  const rows = [
    { label: "extensions", color: BLUE, items: dynamicExtensions() },
    { label: "theme", color: PINK, items: dynamicThemes() },
    { label: "skills", color: WHITE, items: dynamicSkills() },
  ];
  const labelGutter = Math.max(...rows.map((row) => row.label.length)) + 2;
  // Budget: pills + gutter must fit inside the frame (width - 4) at the
  // pill indent, so wrapped rows never get clipped mid-item.
  const pills = pillLines(rows, width - pillIndent - labelGutter - 4);

  const lines: string[] = [];
  TITLE_LINES.forEach((artLine, index) => {
    const pill = pills[index - PILL_ROW_OFFSET];
    if (!pill) {
      lines.push(margin + gradientText(artLine));
      return;
    }
    const gap = Math.max(1, pillIndent - MARGIN - visibleWidth(artLine));
    lines.push(margin + gradientText(artLine) + " ".repeat(gap) + pill);
  });
  // Pill rows that didn't fit beside the logo continue under it.
  for (let i = TITLE_LINES.length - PILL_ROW_OFFSET; i < pills.length; i++) {
    lines.push(" ".repeat(pillIndent) + pills[i]);
  }

  lines.push("");

  const model = modelName(ctx);
  const heading = provider
    ? fg(PINK, model) + fg(MUTED, ` · ${provider.toLowerCase()}`)
    : fg(PINK, model);
  return frame(lines, width, truncateToWidth(heading, width - 8, "…"));
}

export default function (pi: ExtensionAPI) {
  let requestHeaderRender: (() => void) | undefined;

  function installHeader(ctx: ExtensionContext) {
    ctx.ui.setHeader((tui) => {
      requestHeaderRender = () => tui.requestRender();
      return {
        render(width: number) {
          return renderHeader(width, ctx);
        },
        invalidate() {
          tui.requestRender();
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) installHeader(ctx);
  });

  pi.on("model_select", () => requestHeaderRender?.());

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setHeader(undefined);
  });
}
