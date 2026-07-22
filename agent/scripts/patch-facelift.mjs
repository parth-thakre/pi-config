#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const framePath = join(
  agentDir,
  "npm",
  "node_modules",
  "@wierdbytes",
  "pi-common",
  "tool-frame",
  "index.ts",
);
const faceliftPath = join(
  agentDir,
  "npm",
  "node_modules",
  "@wierdbytes",
  "pi-facelift",
  "index.ts",
);

// Close Facelift's frame chrome. The companion responsive component below
// recomputes the final right edge from Component.render(width), so these full
// frames remain valid when the terminal is resized.
const frameReplacements = [
  [
    "const fixed = 1 + 2 + 1 + 1 + minTrailing;\n  const maxTitleW = Math.max(0, w - fixed);",
    "const fixed = 1 + 2 + 1 + 1 + minTrailing + 1;\n  const maxTitleW = Math.max(0, w - fixed);",
  ],
  [
    'const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - tw - 1);\n  const firstLine = `${border("╭──")} ${title} ${border("─".repeat(trailing))}`;',
    'const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - tw - 1 - 1);\n  const firstLine = `${border("╭──")} ${title} ${border(`${"─".repeat(trailing)}╮`)}`;',
  ],
  [
    "const innerW = Math.max(1, w - contentCol + 1);",
    "const innerW = Math.max(1, w - contentCol);",
  ],
  [
    "return `${rail}${padBetween}${connector} ${fitted}`;",
    'const fill = " ".repeat(Math.max(0, innerW - visibleWidth(fitted)));\n    return `${rail}${padBetween}${connector} ${fitted}${fill}${rail}`;',
  ],
  [
    'return border(`╰${"─".repeat(Math.max(1, w - 1))}`);',
    'return border(`╰${"─".repeat(Math.max(1, w - 2))}╯`);',
  ],
  [
    "const fixed = 1 + 2 + 1 + 1 + minTrailing;\n  const maxLabelW = Math.max(0, w - fixed);",
    "const fixed = 1 + 2 + 1 + 1 + minTrailing + 1;\n  const maxLabelW = Math.max(0, w - fixed);",
  ],
  [
    'const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - lw - 1);\n  return `${border("╰──")} ${label} ${border("─".repeat(trailing))}`;',
    'const trailing = Math.max(minTrailing, w - 1 - 2 - 1 - lw - 1 - 1);\n  return `${border("╰──")} ${label} ${border(`${"─".repeat(trailing)}╯`)}`;',
  ],
  [
    "const w = Math.max(1, width - 1 - paddingX);",
    "const w = Math.max(1, width - 2 - paddingX);",
  ],
  [
    "return `${rail}${pad}${fitted}`;",
    'const fill = " ".repeat(Math.max(0, w - visibleWidth(fitted)));\n      return `${rail}${pad}${fitted}${fill}${rail}`;',
  ],
];

const faceliftReplacements = [
  [
    'const MAX_PREVIEW_LINES = envInt("FACELIFT_MAX_PREVIEW_LINES", 8);',
    'const MAX_PREVIEW_LINES = envInt("FACELIFT_MAX_PREVIEW_LINES", 80);\nconst MAX_BASH_PREVIEW_LINES = envInt("FACELIFT_MAX_BASH_PREVIEW_LINES", 8);',
    "const MAX_BASH_PREVIEW_LINES",
  ],
  [
    'const MAX_PREVIEW_LINES = envInt("FACELIFT_MAX_PREVIEW_LINES", 80);',
    'const MAX_PREVIEW_LINES = envInt("FACELIFT_MAX_PREVIEW_LINES", 80);\nconst MAX_BASH_PREVIEW_LINES = envInt("FACELIFT_MAX_BASH_PREVIEW_LINES", 8);',
    "const MAX_BASH_PREVIEW_LINES",
  ],
  [
    'const CACHE_LIMIT = envInt("FACELIFT_CACHE_LIMIT", 128);',
    'const CACHE_LIMIT = envInt("FACELIFT_CACHE_LIMIT", 32);',
  ],
  [
    '\tcodeToANSI("", "typescript", THEME).catch(() => {});',
    '\t// Initialize Shiki lazily on the first highlighted result.',
  ],
  [
    '// Pre-warm\ncodeToANSI("", "typescript", THEME).catch(() => {});',
    '// Shiki is intentionally lazy: pre-warming its engine adds substantial\n// baseline memory even in sessions that never render highlighted source.',
  ],
  [
    'function termW(): number {',
    'const ANSI_ESCAPE = /[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g;\n\nfunction resizeClosedFrame(source: string, requestedWidth: number): string[] | undefined {\n\tif (!source) return undefined;\n\tconst width = Math.max(2, Math.floor(requestedWidth));\n\tconst lines = source.split("\\n");\n\tconst resized: string[] = [];\n\n\tfor (const line of lines) {\n\t\tconst plain = line.replace(ANSI_ESCAPE, "");\n\t\tconst first = plain[0];\n\t\tconst corner = first === "╭" ? "╮" : first === "╰" ? "╯" : first === "│" ? "│" : undefined;\n\t\tif (!corner || plain.at(-1) !== corner) return undefined;\n\n\t\tconst oldWidth = visibleWidth(line);\n\t\tif (oldWidth === width) {\n\t\t\tresized.push(line);\n\t\t\tcontinue;\n\t\t}\n\n\t\tconst cornerIndex = line.lastIndexOf(corner);\n\t\tconst styleIndex = line.lastIndexOf("\\u001b[", cornerIndex);\n\t\tconst rightEdge = line.slice(styleIndex >= 0 ? styleIndex : cornerIndex);\n\t\tconst withoutRight = truncateToWidth(line, Math.max(0, oldWidth - 1), "");\n\t\tconst base = truncateToWidth(withoutRight, width - 1, "");\n\t\tconst fill = (first === "│" ? " " : "─").repeat(\n\t\t\tMath.max(0, width - 1 - visibleWidth(base)),\n\t\t);\n\t\tresized.push(`${base}${fill}${rightEdge}`);\n\t}\n\n\treturn resized;\n}\n\nfunction termW(): number {',
    "function resizeClosedFrame(source: string, requestedWidth: number)",
  ],
  [
    '\t\tconst cornerIndex = line.lastIndexOf(corner);\n\t\tconst styleIndex = line.lastIndexOf("\\u001b[", cornerIndex);\n\t\tconst rightEdge = line.slice(styleIndex >= 0 ? styleIndex : cornerIndex);',
    '\t\tconst cornerIndex = line.lastIndexOf(corner);\n\t\tconst styleIndex = line.lastIndexOf("\\u001b[", cornerIndex);\n\t\tconst styleEnd = styleIndex >= 0 ? line.indexOf("m", styleIndex) + 1 : -1;\n\t\tconst openingStyle = styleEnd > styleIndex ? line.slice(styleIndex, styleEnd) : "";\n\t\tconst rightEdge = `${openingStyle}${corner}${line.slice(cornerIndex + 1)}`;',
  ],
  [
    'if (!createReadTool || !TextComponent) return;\n\n\tconst cwd = process.cwd();',
    'if (!createReadTool || !TextComponent) return;\n\n\t// Facelift normally bakes terminal width into Text before the component is\n\t// rendered. Preserve that source, then move the closed right edge to the\n\t// actual width supplied by pi-tui on every render (including after resize).\n\tconst BaseTextComponent = TextComponent as TextComponentCtor & { prototype: { render?: (width: number) => string[] } };\n\tTextComponent = class ResponsiveFrameText extends (BaseTextComponent as any) {\n\t\tprivate frameSource = "";\n\n\t\toverride setText(value: string): void {\n\t\t\tthis.frameSource = value;\n\t\t\tsuper.setText(value);\n\t\t}\n\n\t\toverride render(width: number): string[] {\n\t\t\tconst resized = resizeClosedFrame(this.frameSource, width);\n\t\t\tif (resized) return resized;\n\t\t\tconst render = BaseTextComponent.prototype.render;\n\t\t\treturn render ? render.call(this, width) : [truncateToWidth(this.frameSource, width, "")];\n\t\t}\n\t} as unknown as TextComponentCtor;\n\n\tconst cwd = process.cwd();',
    "class ResponsiveFrameText extends",
  ],
  [
    '\t\tprivate frameSource = "";\n\n\t\toverride setText(value: string): void {\n\t\t\tthis.frameSource = value;\n\t\t\tsuper.setText(value);\n\t\t}\n\n\t\toverride render(width: number): string[] {\n\t\t\tconst resized = resizeClosedFrame(this.frameSource, width);\n\t\t\tif (resized) return resized;\n\t\t\tconst render = BaseTextComponent.prototype.render;\n\t\t\treturn render ? render.call(this, width) : [truncateToWidth(this.frameSource, width, "")];\n\t\t}',
    '\t\tprivate frameSource = "";\n\t\tprivate frameWidth?: number;\n\t\tprivate frameLines?: string[];\n\n\t\toverride setText(value: string): void {\n\t\t\tthis.frameSource = value;\n\t\t\tthis.frameWidth = undefined;\n\t\t\tthis.frameLines = undefined;\n\t\t\tsuper.setText(value);\n\t\t}\n\n\t\toverride invalidate(): void {\n\t\t\tthis.frameWidth = undefined;\n\t\t\tthis.frameLines = undefined;\n\t\t\tsuper.invalidate();\n\t\t}\n\n\t\toverride render(width: number): string[] {\n\t\t\tif (this.frameLines && this.frameWidth === width) return this.frameLines;\n\t\t\tconst resized = resizeClosedFrame(this.frameSource, width);\n\t\t\tif (resized) {\n\t\t\t\tthis.frameWidth = width;\n\t\t\t\tthis.frameLines = resized;\n\t\t\t\treturn resized;\n\t\t\t}\n\t\t\tconst render = BaseTextComponent.prototype.render;\n\t\t\treturn render ? render.call(this, width) : [truncateToWidth(this.frameSource, width, "")];\n\t\t}',
  ],
  [
    '\t\t\t\tlet exitCode: number | null = d?._type === "bashResult" ? d.exitCode : null;',
    '\t\t\t\tbodyText = bodyText.replace(/\\r\\n/g, "\\n");\n\t\t\t\tlet exitCode: number | null = d?._type === "bashResult" ? d.exitCode : null;',
  ],
  [
    '\t\t\t\tif (exitCode === null && !opt.isPartial && !ctx.isError) exitCode = 0;',
    '\t\t\t\tbodyText = bodyText.replace(/\\n$/, "");\n\t\t\t\tif (exitCode === null && !opt.isPartial && !ctx.isError) exitCode = 0;',
  ],
  [
    '\t\t\t\tconst maxShow = ctx.expanded ? lineCount : MAX_PREVIEW_LINES;',
    '\t\t\t\tconst maxShow = ctx.expanded ? lineCount : MAX_BASH_PREVIEW_LINES;',
  ],
  [
    'theme.fg("toolOutput", line.replace(ANSI_ESCAPE, ""))',
    'theme.fg("text", line.replace(ANSI_ESCAPE, ""))',
  ],
  [
    '\t\t\t\tconst show = lines.slice(0, Math.max(0, maxShow));\n\t\t\t\tconst out: string[] = [...show];',
    '\t\t\t\tconst show = lines.slice(0, Math.max(0, maxShow));\n\t\t\t\tconst out: string[] = show.map((line) =>\n\t\t\t\t\tline.includes("\\u001b") ? line : theme.fg("text", line),\n\t\t\t\t);',
    'theme.fg("text", line.replace(ANSI_ESCAPE, ""))',
  ],
  [
    '\t\t\t\tconst out: string[] = show.map((line) =>\n\t\t\t\t\tline.includes("\\u001b") ? line : theme.fg("text", line),\n\t\t\t\t);',
    '\t\t\t\tconst out: string[] = show.map((line) =>\n\t\t\t\t\ttheme.fg("text", line.replace(ANSI_ESCAPE, "")),\n\t\t\t\t);',
  ],
  [
    '// The full command is always rendered in the title — no length-based\n\t\t\t\t// truncation in compact mode. `frameTop` still right-truncates any\n\t\t\t\t// individual line that exceeds the frame width, which is a separate\n\t\t\t\t// (display-fit) concern from hiding command content.\n\t\t\t\tconst cmdLines = cmd.split("\\n");\n\t\t\t\tconst firstCmd = cmdLines[0];\n\t\t\t\tconst restCmd = cmdLines.slice(1).map((line) => line.replace(/^\\s+/, ""));',
    '// Keep compact tool calls compact: heredocs (especially inline Python) can\n\t\t\t\t// contain hundreds of lines. Show their full source only when expanded.\n\t\t\t\t// `frameTop` still right-truncates individual lines to fit the display.\n\t\t\t\tconst cmdLines = cmd.split("\\n");\n\t\t\t\tconst firstCmd = cmdLines[0];\n\t\t\t\tconst allRestCmd = cmdLines.slice(1).map((line) => line.replace(/^\\s+/, ""));\n\t\t\t\tconst restCmd = ctx.expanded\n\t\t\t\t\t? allRestCmd\n\t\t\t\t\t: allRestCmd.length > 0\n\t\t\t\t\t\t? [theme.fg("muted", `… ${allRestCmd.length} more line${allRestCmd.length === 1 ? "" : "s"}`)]\n\t\t\t\t\t\t: [];',
  ],
  [
    'const title = [firstTitle, ...restCmd.map((line) => theme.fg("accent", line))].join("\\n");',
    'const title = [\n\t\t\t\t\tfirstTitle,\n\t\t\t\t\t...restCmd.map((line) => (ctx.expanded ? theme.fg("accent", line) : line)),\n\t\t\t\t].join("\\n");',
  ],
];

async function patchFile(path, replacements) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Facelift is not installed at ${path}. Start Pi once, then run this script again.`,
    );
  }

  let changed = false;
  for (const [original, patched, marker = patched] of replacements) {
    if (source.includes(marker)) continue;
    if (!source.includes(original)) {
      throw new Error(
        `The installed Facelift source has changed at ${path}; missing patch anchor: ${JSON.stringify(original.slice(0, 120))}`,
      );
    }
    source = source.replace(original, patched);
    changed = true;
  }

  if (changed) await writeFile(path, source, "utf8");
  return changed;
}

const changed =
  (await patchFile(framePath, frameReplacements)) |
  (await patchFile(faceliftPath, faceliftReplacements));

console.log(
  changed
    ? "Patched Facelift with resize-safe frames and compact multiline commands."
    : "Facelift resize and multiline-command patches are already applied.",
);
