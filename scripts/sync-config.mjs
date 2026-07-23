import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "agent");
const target = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const directories = [
  "extensions",
  "extensions.disabled",
  "scripts",
  "skills",
  "themes",
  "themes.disabled",
  "wierd-facelift",
];
const files = [
  "keybindings.json",
  "models.json",
  "package.json",
  "package-lock.json",
  "settings.json",
  "tsconfig.davis.json",
  "tsconfig.json",
  "update-llamacpp-models.py",
];

await mkdir(target, { recursive: true });
for (const name of directories) {
  await rm(join(target, name), { recursive: true, force: true });
  await cp(join(source, name), join(target, name), { recursive: true });
}
for (const name of files) {
  await cp(join(source, name), join(target, name), { force: true });
}

const install = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
  cwd: target,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

console.log(`Synced Pi config to ${target}`);
