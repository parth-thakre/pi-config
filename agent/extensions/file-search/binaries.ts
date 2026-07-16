import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type SearchToolName = "fd" | "rg";
export type BinarySource = "bundled" | "path";

export interface ResolvedBinary {
  readonly tool: SearchToolName;
  readonly command: string;
  readonly source: BinarySource;
  readonly version?: string;
}

export interface BinaryResolutionOptions {
  readonly home?: string;
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
  readonly isUsableFile?: (path: string) => boolean;
}

const BUNDLED_VERSIONS: Record<SearchToolName, string> = {
  fd: "10.4.2",
  rg: "15.1.0",
};

function defaultIsUsableFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function bundledBinaryPath(
  tool: SearchToolName,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
) {
  const suffix = platform === "win32" ? ".exe" : "";
  return join(home, ".pi", "agent", "bin", `${tool}${suffix}`);
}

function pathCandidates(
  tool: SearchToolName,
  pathValue: string,
  platform: NodeJS.Platform,
) {
  const names = platform === "win32" ? [`${tool}.exe`, tool] : [tool];
  const candidates: string[] = [];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const name of names) candidates.push(join(directory, name));
  }
  return candidates;
}

/** Prefer the trusted local binaries, then resolve an existing PATH entry. */
export function resolveSearchBinary(
  tool: SearchToolName,
  options: BinaryResolutionOptions = {},
): ResolvedBinary {
  const platform = options.platform ?? process.platform;
  const isUsable = options.isUsableFile ?? defaultIsUsableFile;
  const bundled = bundledBinaryPath(tool, options.home ?? homedir(), platform);
  if (isUsable(bundled)) {
    return {
      tool,
      command: bundled,
      source: "bundled",
      version: BUNDLED_VERSIONS[tool],
    };
  }

  const pathValue = options.path ?? process.env.PATH ?? "";
  const fallback = pathCandidates(tool, pathValue, platform).find(isUsable);
  if (fallback) return { tool, command: fallback, source: "path" };

  throw new Error(
    `${tool} executable not found. Expected the trusted binary at ${bundled} or an existing ${tool}${platform === "win32" ? ".exe" : ""} on PATH. No download was attempted.`,
  );
}
