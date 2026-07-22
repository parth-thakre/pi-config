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

const replacements = [
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

let source;
try {
  source = await readFile(framePath, "utf8");
} catch {
  console.error(
    `Facelift is not installed at ${framePath}. Start Pi once, then run this script again.`,
  );
  process.exit(1);
}

let changed = false;
for (const [openFrame, closedFrame] of replacements) {
  if (source.includes(closedFrame)) continue;
  if (!source.includes(openFrame)) {
    throw new Error(
      "The installed Facelift frame source has changed. Refusing to apply a partial patch; review the package update first.",
    );
  }
  source = source.replace(openFrame, closedFrame);
  changed = true;
}

if (changed) {
  await writeFile(framePath, source, "utf8");
  console.log("Patched Facelift with fully closed tool frames.");
} else {
  console.log("Facelift closed-frame patch is already applied.");
}
