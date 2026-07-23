import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const candidates = [
  join(homedir(), ".pi", "agent", "npm", "node_modules", "@wierdbytes", "pi-facelift", "index.ts"),
  join(homedir(), ".pi", "agent", "node_modules", "@wierdbytes", "pi-facelift", "index.ts"),
];

const alias = '\t"trans-pride": "rose-pine-moon",';
let found = false;

for (const file of candidates) {
  if (!existsSync(file)) continue;
  found = true;
  const source = readFileSync(file, "utf8");
  if (source.includes(alias)) {
    console.log(`pi-facelift trans-pride alias already installed: ${file}`);
    continue;
  }

  const anchor = "const THEME_ALIASES: Record<string, BundledTheme> = {";
  if (!source.includes(anchor)) {
    throw new Error(`Unable to patch pi-facelift: alias map not found in ${file}`);
  }

  writeFileSync(file, source.replace(anchor, `${anchor}\n${alias}`), "utf8");
  console.log(`Installed pi-facelift trans-pride alias: ${file}`);
}

if (!found) {
  console.log("pi-facelift is not installed yet; rerun npm run patch:facelift-theme after Pi installs its packages.");
}
