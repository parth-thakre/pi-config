import { homedir } from "node:os";
import { join } from "node:path";

export const FD_DEFAULT_LIMIT = 1_000;
export const FD_MAX_LIMIT = 10_000;
export const FD_MAX_DEPTH = 64;
export const RG_DEFAULT_LIMIT = 100;
export const RG_MAX_LIMIT = 1_000;
export const RG_MAX_CONTEXT = 20;

export type FdEntryType = "file" | "directory" | "symlink";

export interface FdToolParams {
  pattern?: string;
  path?: string;
  type?: FdEntryType;
  extension?: string;
  glob?: boolean;
  hidden?: boolean;
  no_ignore?: boolean;
  max_depth?: number;
  limit?: number;
}

export interface RgToolParams {
  pattern: string;
  path?: string;
  glob?: string;
  file_type?: string;
  case_sensitive?: boolean;
  fixed_strings?: boolean;
  hidden?: boolean;
  no_ignore?: boolean;
  context?: number;
  limit?: number;
}

const FD_TYPE_FLAGS: Record<FdEntryType, string> = {
  file: "f",
  directory: "d",
  symlink: "l",
};

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

/** Match Pi's built-in path normalization without changing meaningful spaces. */
export function normalizeSearchPath(raw: string, home = homedir()) {
  let value = raw.startsWith("@") ? raw.slice(1) : raw;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(home, value.slice(2));
  }
  return value;
}

function optionalPath(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const normalized = normalizeSearchPath(raw);
  return normalized === "" ? undefined : normalized;
}

/** Build fd argv without invoking a shell. User values stay behind `--`. */
export function buildFdArgs(params: FdToolParams) {
  const args = ["--color=never"];
  if (params.hidden) args.push("--hidden");
  if (params.no_ignore) args.push("--no-ignore");
  if (params.glob) args.push("--glob");
  if (params.type) args.push("--type", FD_TYPE_FLAGS[params.type]);
  if (params.extension) {
    args.push("--extension", params.extension.replace(/^\.+/, ""));
  }
  if (params.max_depth !== undefined) {
    args.push(
      "--max-depth",
      String(clampInteger(params.max_depth, 1, FD_MAX_DEPTH)),
    );
  }
  args.push(
    "--max-results",
    String(clampInteger(params.limit ?? FD_DEFAULT_LIMIT, 1, FD_MAX_LIMIT)),
  );
  args.push("--", params.pattern ?? "");
  const path = optionalPath(params.path);
  if (path !== undefined) args.push(path);
  return args;
}

/** Build ripgrep argv without invoking a shell. Pattern and path follow `--`. */
export function buildRgArgs(params: RgToolParams) {
  const args = [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
  ];
  if (params.case_sensitive === true) args.push("--case-sensitive");
  else if (params.case_sensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");
  if (params.fixed_strings) args.push("--fixed-strings");
  if (params.hidden) args.push("--hidden");
  if (params.no_ignore) args.push("--no-ignore");
  if (params.context !== undefined) {
    args.push(
      "--context",
      String(clampInteger(params.context, 0, RG_MAX_CONTEXT)),
    );
  }
  if (params.glob) args.push("--glob", params.glob);
  if (params.file_type) args.push("--type", params.file_type);
  args.push(
    "--max-count",
    String(clampInteger(params.limit ?? RG_DEFAULT_LIMIT, 1, RG_MAX_LIMIT)),
  );
  args.push("--", params.pattern);
  const path = optionalPath(params.path);
  if (path !== undefined) args.push(path);
  return args;
}
