#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tropeExtension = join(agentDir, "extensions", "trope-cua.ts");

if (process.platform === "win32" || process.platform === "darwin") {
  console.log(
    `Trope CUA extension enabled for ${process.platform === "win32" ? "Windows" : "macOS"}. Install the native trope-cua command separately if needed.`,
  );
} else {
  await rm(tropeExtension, { force: true });
  console.log(
    `Trope CUA extension not installed on ${process.platform}; Windows and macOS only.`,
  );
}
