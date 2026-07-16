import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  keyHint,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  buildFdArgs,
  buildRgArgs,
  FD_MAX_DEPTH,
  FD_MAX_LIMIT,
  RG_MAX_CONTEXT,
  RG_MAX_LIMIT,
} from "./args.ts";
import {
  resolveSearchBinary,
  type BinarySource,
  type ResolvedBinary,
  type SearchToolName,
} from "./binaries.ts";
import {
  BoundedStderrCapture,
  StreamingSearchCapture,
  searchFailureMessage,
  type TruncationMetadata,
} from "./output.ts";
import {
  FD_PARAMETER_DESCRIPTIONS,
  FD_PROMPT_GUIDELINES,
  FD_PROMPT_SNIPPET,
  FD_TOOL_DESCRIPTION,
  RG_PARAMETER_DESCRIPTIONS,
  RG_PROMPT_GUIDELINES,
  RG_PROMPT_SNIPPET,
  RG_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export const SEARCH_TIMEOUT_MS = 60_000;
const PREVIEW_MAX_BYTES = 8 * 1024;
const PREVIEW_MAX_LINES = 20;

type SearchStatusTone = "warning" | "success" | "error" | "dim";

interface CommonDetails {
  readonly binarySource: BinarySource;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
  readonly truncation?: TruncationMetadata;
}

export interface FdToolDetails extends CommonDetails {
  readonly matchCount: number;
}

export interface RgToolDetails extends CommonDetails {
  readonly outputLines: number;
}

export interface FileSearchOptions {
  readonly timeoutMs?: number;
  readonly resolveBinary?: (tool: SearchToolName) => ResolvedBinary;
}

function compactDisplay(value: unknown, fallback: string) {
  const text = sanitizeTerminalText(typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim();
  return text || fallback;
}

function flagsFor(tool: SearchToolName, args: Record<string, unknown>) {
  const flags: string[] = [];
  if (tool === "fd") {
    if (typeof args.type === "string") flags.push(args.type[0] ?? "");
    if (typeof args.extension === "string")
      flags.push(`ext=${compactDisplay(args.extension, "?")}`);
    if (args.glob === true) flags.push("glob");
    if (args.hidden === true) flags.push("hidden");
    if (args.no_ignore === true) flags.push("ignored");
    if (typeof args.max_depth === "number")
      flags.push(`depth=${args.max_depth}`);
    if (typeof args.limit === "number") flags.push(`limit=${args.limit}`);
  } else {
    flags.push(
      args.case_sensitive === true
        ? "case"
        : args.case_sensitive === false
          ? "nocase"
          : "smart",
    );
    if (args.fixed_strings === true) flags.push("fixed");
    if (typeof args.glob === "string")
      flags.push(`glob=${compactDisplay(args.glob, "?")}`);
    if (typeof args.file_type === "string")
      flags.push(`type=${compactDisplay(args.file_type, "?")}`);
    if (args.hidden === true) flags.push("hidden");
    if (args.no_ignore === true) flags.push("ignored");
    if (typeof args.context === "number") flags.push(`ctx=${args.context}`);
    if (typeof args.limit === "number") flags.push(`limit=${args.limit}`);
  }
  return flags.filter(Boolean).join(",");
}

function identityFor(tool: SearchToolName, args: Record<string, unknown>) {
  const pattern = compactDisplay(
    args.pattern,
    tool === "fd" ? "(all)" : "[missing pattern]",
  );
  const path = compactDisplay(args.path, ".");
  return { pattern: `"${pattern}"`, path };
}

function fitIdentity(pattern: string, path: string, width: number) {
  if (width <= 0) return "";
  const separator = " @ ";
  const combined = `${pattern}${separator}${path}`;
  if (visibleWidth(combined) <= width) return combined;
  if (width < 8) return truncateToWidth(combined, width, "…");

  const available = width - visibleWidth(separator);
  const patternWidth = Math.max(3, Math.ceil(available * 0.55));
  const pathWidth = Math.max(3, available - patternWidth);
  return `${truncateToWidth(pattern, patternWidth, "…")}${separator}${truncateToWidth(path, pathWidth, "…")}`;
}

function resultText(result: AgentToolResult<unknown>) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function previewLines(
  result: AgentToolResult<unknown>,
  fullOutputPath: string | undefined,
) {
  const safe = sanitizeTerminalText(resultText(result));
  const preview = truncateHead(safe, {
    maxBytes: PREVIEW_MAX_BYTES,
    maxLines: PREVIEW_MAX_LINES,
  });
  const lines = preview.content ? preview.content.split("\n") : [];
  if (preview.truncated) lines.push("… expanded preview limited");
  if (fullOutputPath) {
    lines.push(`Full output: ${sanitizeTerminalText(fullOutputPath)}`);
  }
  return lines;
}

class SearchRenderComponent implements Component {
  private readonly tool: SearchToolName;
  private readonly args: Record<string, unknown>;
  private readonly theme: Theme;
  private readonly options: {
    status?: string;
    tone?: SearchStatusTone;
    hint?: string;
    preview?: string[];
  };

  constructor(
    tool: SearchToolName,
    args: Record<string, unknown>,
    theme: Theme,
    options: {
      status?: string;
      tone?: SearchStatusTone;
      hint?: string;
      preview?: string[];
    } = {},
  ) {
    this.tool = tool;
    this.args = args;
    this.theme = theme;
    this.options = options;
  }

  render(width: number) {
    if (width <= 0) return [""];
    const title = this.theme.fg("toolTitle", this.theme.bold(`${this.tool} `));
    const flagText = flagsFor(this.tool, this.args);
    const flags = flagText ? this.theme.fg("dim", ` [${flagText}]`) : "";
    const status = this.options.status
      ? this.theme.fg(
          this.options.tone ?? "success",
          ` · ${compactDisplay(this.options.status, "done")}`,
        )
      : "";
    const hint = this.options.hint
      ? this.theme.fg("dim", ` (${this.options.hint})`)
      : "";
    const suffix = `${status}${flags}${hint}`;
    const { pattern, path } = identityFor(this.tool, this.args);
    const available = Math.max(1, width - visibleWidth(title));
    const fullIdentity = fitIdentity(pattern, path, available);
    const fullWidth = visibleWidth(fullIdentity) + visibleWidth(suffix);
    const identityWidth =
      fullWidth <= available
        ? visibleWidth(fullIdentity)
        : Math.max(1, Math.floor(available * 0.45));
    const suffixWidth = Math.max(0, available - identityWidth);
    const identity = this.theme.fg(
      "accent",
      fitIdentity(pattern, path, identityWidth),
    );
    const fittedSuffix = truncateToWidth(suffix, suffixWidth, "…");
    const header = truncateToWidth(
      `${title}${identity}${fittedSuffix}`,
      width,
      "",
    );
    const body = (this.options.preview ?? []).map((line) =>
      this.theme.fg(
        "toolOutput",
        truncateToWidth(sanitizeTerminalText(line), width, "…"),
      ),
    );
    return [header, ...body];
  }

  invalidate() {}
}

async function runSearch(
  tool: SearchToolName,
  args: string[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  options: FileSearchOptions,
) {
  if (signal?.aborted) throw new Error(`${tool} search was cancelled.`);
  const binary = (options.resolveBinary ?? resolveSearchBinary)(tool);
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? SEARCH_TIMEOUT_MS),
  );
  const stdout = new StreamingSearchCapture(
    tool === "fd" ? "pi-fd-" : "pi-rg-",
  );
  const stderr = new BoundedStderrCapture();
  let timedOut = false;
  let cancelled = false;
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(binary.command, args, {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${tool} could not start: ${message}`, { cause: error });
  }

  const stop = () => {
    try {
      child.kill();
    } catch {
      // The close/error event remains authoritative.
    }
  };
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);

  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const consumeStdout = (async () => {
    for await (const chunk of child.stdout) {
      await stdout.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  })();
  const consumeStderr = (async () => {
    for await (const chunk of child.stderr) {
      stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  })();

  let code: number;
  try {
    [code] = await Promise.all([exit, consumeStdout, consumeStderr]);
  } catch (error) {
    stop();
    if (signal?.aborted || cancelled)
      throw new Error(`${tool} search was cancelled.`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${tool} could not run: ${message}`, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const formatted = await stdout.finish();
  const errorOutput = stderr.finish();
  if (signal?.aborted || cancelled)
    throw new Error(`${tool} search was cancelled.`);
  if (timedOut) throw new Error(`${tool} search timed out after ${timeoutMs} ms.`);
  if (tool === "rg" && code === 1) {
    return { binary, formatted, noMatches: true };
  }
  if (code !== 0) {
    throw new Error(searchFailureMessage(tool, code, errorOutput));
  }
  return { binary, formatted, noMatches: formatted.lineCount === 0 };
}

function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.pattern }),
    ),
    path: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: FD_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    extension: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.extension }),
    ),
    glob: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.glob }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    no_ignore: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.no_ignore }),
    ),
    max_depth: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.max_depth,
        minimum: 1,
        maximum: FD_MAX_DEPTH,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: RG_PARAMETER_DESCRIPTIONS.pattern }),
    path: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.path }),
    ),
    glob: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.glob }),
    ),
    file_type: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.file_type }),
    ),
    case_sensitive: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.case_sensitive }),
    ),
    fixed_strings: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.fixed_strings }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    no_ignore: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.no_ignore }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_LIMIT,
      }),
    ),
  });
}

export default function fileSearchTools(
  pi: ExtensionAPI,
  options: FileSearchOptions = {},
) {
  pi.registerTool({
    name: "fd",
    label: "Find Files (fd)",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch(
        "fd",
        buildFdArgs(params),
        signal,
        ctx,
        options,
      );
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No files found" }],
          details: {
            binarySource: outcome.binary.source,
            matchCount: 0,
            truncated: false,
          } satisfies FdToolDetails,
        };
      }
      const formatted = outcome.formatted;
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binary.source,
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          truncation: formatted.truncation,
          fullOutputPath: formatted.fullOutputPath,
        } satisfies FdToolDetails,
      };
    },
    renderCall(_args, theme, context) {
      return new SearchRenderComponent("fd", context.args, theme);
    },
    renderResult(result, renderOptions, theme, context) {
      const details = result.details as FdToolDetails | undefined;
      const status = renderOptions.isPartial
        ? "searching…"
        : context.isError
          ? "failed"
          : details?.matchCount
            ? `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}${details.truncated ? " · truncated" : ""}`
            : "no files";
      return new SearchRenderComponent("fd", context.args, theme, {
        status,
        tone: renderOptions.isPartial
          ? "warning"
          : context.isError
            ? "error"
            : details?.matchCount
              ? "success"
              : "dim",
        hint:
          !renderOptions.expanded && !renderOptions.isPartial
            ? keyHint("app.tools.expand", "to expand")
            : undefined,
        preview:
          renderOptions.expanded && !renderOptions.isPartial
            ? previewLines(result, details?.fullOutputPath)
            : undefined,
      });
    },
  });

  pi.registerTool({
    name: "rg",
    label: "Search Content (rg)",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch(
        "rg",
        buildRgArgs(params),
        signal,
        ctx,
        options,
      );
      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            binarySource: outcome.binary.source,
            outputLines: 0,
            truncated: false,
          } satisfies RgToolDetails,
        };
      }
      const formatted = outcome.formatted;
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binary.source,
          outputLines: formatted.lineCount,
          truncated: formatted.truncated,
          truncation: formatted.truncation,
          fullOutputPath: formatted.fullOutputPath,
        } satisfies RgToolDetails,
      };
    },
    renderCall(_args, theme, context) {
      return new SearchRenderComponent("rg", context.args, theme);
    },
    renderResult(result, renderOptions, theme, context) {
      const details = result.details as RgToolDetails | undefined;
      const status = renderOptions.isPartial
        ? "searching…"
        : context.isError
          ? "failed"
          : details?.outputLines
            ? `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}${details.truncated ? " · truncated" : ""}`
            : "no matches";
      return new SearchRenderComponent("rg", context.args, theme, {
        status,
        tone: renderOptions.isPartial
          ? "warning"
          : context.isError
            ? "error"
            : details?.outputLines
              ? "success"
              : "dim",
        hint:
          !renderOptions.expanded && !renderOptions.isPartial
            ? keyHint("app.tools.expand", "to expand")
            : undefined,
        preview:
          renderOptions.expanded && !renderOptions.isPartial
            ? previewLines(result, details?.fullOutputPath)
            : undefined,
      });
    },
  });
}
