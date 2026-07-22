import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  closedToolFrameResult,
  closedToolFrameTop,
  toolFrameStatus,
} from "./shared/closed-tool-frame.ts";
import { sanitizeTerminalText } from "./shared/terminal-text.ts";

const TOOLS = [
  "list_windows",
  "list_apps",
  "get_window_state",
  "screenshot",
  "zoom",
  "find_element",
  "click",
  "right_click",
  "double_click",
  "type_text",
  "type_text_chars",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
  "launch_app",
  "get_screen_size",
  "get_cursor_position",
  "move_cursor",
  "get_agent_cursor_state",
] as const;

const WINDOW_TARGET_TOOLS = new Set<(typeof TOOLS)[number]>([
  "get_window_state",
  "screenshot",
  "zoom",
  "find_element",
  "click",
  "right_click",
  "double_click",
  "type_text",
  "type_text_chars",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
]);

const RESULT_TEXT_MAX_BYTES = 50 * 1024;
const RESULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const RESULT_IMAGE_MAX_COUNT = 4;
const SESSION_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const DETAILS_MAX_STRING_BYTES = 1_024;
const DETAILS_MAX_BYTES = 16 * 1024;
const DETAILS_MAX_DEPTH = 2;
const DETAILS_MAX_ITEMS = 16;

const argsSchema = Type.Object(
  {
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    window_id: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  {
    additionalProperties: true,
    description:
      "Arguments for the selected Trope CUA operation. Window-targeted operations require positive integer pid and window_id.",
  },
);

const schema = Type.Object({
  tool: StringEnum(TOOLS, { description: "Trope CUA operation to invoke." }),
  args: Type.Optional(argsSchema),
});

export type TropeParams = {
  tool: (typeof TOOLS)[number];
  args?: Record<string, unknown>;
};

type TropeBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type TropeResult = {
  content?: TropeBlock[];
  isError?: boolean;
  structuredContent?: unknown;
};

interface DaemonOwner {
  usedBytes: number;
}

interface DaemonState {
  instance: string;
  started: boolean;
  owners: Map<symbol, DaemonOwner>;
  stopping?: Promise<void>;
}

const DAEMON_STATE_KEY = Symbol.for("pi.trope-cua.daemon-state");
const daemonState = (() => {
  const root = globalThis as typeof globalThis & {
    [DAEMON_STATE_KEY]?: DaemonState;
  };
  return (root[DAEMON_STATE_KEY] ??= {
    instance: `pi-${process.pid}`,
    started: false,
    owners: new Map(),
  });
})();

function utf8Head(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function compactValue(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return utf8Head(sanitizeTerminalText(value), DETAILS_MAX_STRING_BYTES);
  }
  if (depth >= DETAILS_MAX_DEPTH) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, DETAILS_MAX_ITEMS)
      .map((item) => compactValue(item, depth + 1));
    if (value.length > DETAILS_MAX_ITEMS) {
      items.push(`[${value.length - DETAILS_MAX_ITEMS} more items omitted]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      DETAILS_MAX_ITEMS,
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [
        utf8Head(sanitizeTerminalText(key), 128),
        compactValue(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function validateTropeTarget(params: TropeParams) {
  if (!WINDOW_TARGET_TOOLS.has(params.tool)) return;
  const args = params.args ?? {};
  for (const field of ["pid", "window_id"] as const) {
    const value = args[field];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(
        `${params.tool} requires an explicit positive integer ${field}`,
      );
    }
  }
}

export function boundTropeResult(result: TropeResult) {
  const content: TropeBlock[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  let omittedImages = 0;
  let textTruncated = false;

  for (const block of result.content ?? []) {
    if (block.type === "image") {
      const bytes = Buffer.byteLength(block.data, "base64");
      if (bytes > RESULT_IMAGE_MAX_BYTES) {
        throw new Error(
          `Trope CUA image exceeds the ${RESULT_IMAGE_MAX_BYTES} byte result limit`,
        );
      }
      if (
        imageCount >= RESULT_IMAGE_MAX_COUNT ||
        imageBytes + bytes > RESULT_IMAGE_MAX_BYTES
      ) {
        omittedImages++;
        continue;
      }
      content.push({
        type: "image",
        data: block.data,
        mimeType: utf8Head(sanitizeTerminalText(block.mimeType), 128),
      });
      imageCount++;
      imageBytes += bytes;
      continue;
    }

    const clean = sanitizeTerminalText(block.text);
    const remaining = RESULT_TEXT_MAX_BYTES - textBytes;
    if (remaining <= 0) {
      textTruncated = true;
      continue;
    }
    const bounded = utf8Head(clean, remaining);
    content.push({ type: "text", text: bounded });
    textBytes += Buffer.byteLength(bounded, "utf8");
    if (bounded !== clean) textTruncated = true;
  }

  const notices: string[] = [];
  if (textTruncated) notices.push("text truncated at the aggregate 50KB limit");
  if (omittedImages > 0)
    notices.push(`${omittedImages} image(s) omitted by aggregate limits`);
  if (notices.length > 0) {
    const notice = `[Trope CUA: ${notices.join("; ")}]`;
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    let excess = Math.max(0, textBytes + noticeBytes - RESULT_TEXT_MAX_BYTES);
    for (let index = content.length - 1; index >= 0 && excess > 0; index--) {
      const block = content[index];
      if (block?.type !== "text") continue;
      const bytes = Buffer.byteLength(block.text, "utf8");
      const keep = Math.max(0, bytes - excess);
      block.text = utf8Head(block.text, keep);
      const removed = bytes - Buffer.byteLength(block.text, "utf8");
      textBytes -= removed;
      excess -= removed;
    }
    content.push({ type: "text", text: notice });
    textBytes += noticeBytes;
  }

  let structured = compactValue(result.structuredContent);
  if (
    structured !== undefined &&
    Buffer.byteLength(JSON.stringify(structured), "utf8") > DETAILS_MAX_BYTES
  ) {
    structured = {
      omitted: "structured details exceeded 16KB",
      keys:
        result.structuredContent && typeof result.structuredContent === "object"
          ? Object.keys(result.structuredContent).slice(0, DETAILS_MAX_ITEMS)
          : [],
    };
  }
  const details = {
    textBytes,
    imageBytes,
    imageCount,
    omittedImages,
    ...(structured === undefined ? {} : { structured }),
  };
  const detailsBytes = Buffer.byteLength(JSON.stringify(details), "utf8");
  return {
    content,
    details,
    outputBytes: textBytes + imageBytes + detailsBytes,
  };
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted)
    return Promise.reject(new Error("Trope CUA call cancelled"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Trope CUA call cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default function tropeCuaExtension(pi: ExtensionAPI) {
  if (process.platform !== "win32" && process.platform !== "darwin") return;

  process.env.TROPE_CUA_JSON = "1";
  const configuredExecutable = process.env.TROPE_CUA_PATH?.trim();
  const exe =
    configuredExecutable ||
    (process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "TropeCUA", "trope-cua.exe")
      : process.platform === "win32"
        ? "trope-cua.exe"
        : "trope-cua");
  const platformName = process.platform === "darwin" ? "macOS" : "Windows";
  const assertInstalled = () => {
    if (isAbsolute(exe) && !existsSync(exe)) {
      throw new Error(
        `Trope CUA is not installed at ${exe}. Install it on ${platformName} or set TROPE_CUA_PATH.`,
      );
    }
  };
  const ownerToken = Symbol("trope-cua-session");
  let sessionActive = false;

  const acquireOwner = () => {
    if (!daemonState.owners.has(ownerToken)) {
      daemonState.owners.set(ownerToken, { usedBytes: 0 });
    }
  };

  function startDaemon() {
    if (daemonState.started) return;
    assertInstalled();
    const child = spawn(exe, ["serve", "--instance", daemonState.instance], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TROPE_CUA_JSON: "1" },
    });
    daemonState.started = true;
    child.once("error", () => {
      daemonState.started = false;
    });
    child.unref();
  }

  async function invoke(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TropeResult> {
    acquireOwner();
    startDaemon();
    let last = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      if (signal?.aborted) throw new Error("Trope CUA call cancelled");
      const result = await pi.exec(
        exe,
        [
          "call",
          "--instance",
          daemonState.instance,
          tool,
          JSON.stringify(args),
        ],
        { signal, timeout: 120_000 },
      );
      last = result.stdout || result.stderr;
      if (result.code === 0 && result.stdout.trim()) {
        try {
          return JSON.parse(result.stdout) as TropeResult;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
      }
      await abortableDelay(150, signal);
    }
    throw new Error(last.trim() || `Trope CUA ${tool} failed`);
  }

  async function rejectPrivateWindow(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const windowId = args.window_id as number;
    const pid = args.pid as number;
    const result = await invoke("list_windows", { pid, verbose: true }, signal);
    const windows =
      (
        result.structuredContent as
          | {
              windows?: Array<{
                window_id?: number;
                pid?: number;
                title?: string;
              }>;
            }
          | undefined
      )?.windows ?? [];
    const target = windows.find(
      (window) =>
        window.window_id === windowId &&
        (window.pid === undefined || window.pid === pid),
    );
    if (!target) {
      throw new Error(
        `Window ${pid}/${windowId} was not found during safety validation`,
      );
    }
    if (target.title?.toLowerCase().includes("private browsing")) {
      throw new Error(
        "Refusing to inspect or interact with a private-browsing window.",
      );
    }
  }

  pi.registerTool({
    name: "trope_cua",
    label: "Trope CUA",
    description: `Inspect and operate ${platformName} apps through Trope CUA. Use vision screenshots by default. Supported operations include window/app discovery, screenshots, zoom, clicks, typing, keys, scrolling, element lookup, and app launch. Always use explicit pid/window_id, inspect action receipts, and verify mutations with a new screenshot.`,
    promptSnippet: `Use Trope CUA for visible ${platformName} GUI inspection and interaction`,
    promptGuidelines: [
      `Use trope_cua instead of computer_* tools for ${platformName} GUI work.`,
      "Use trope_cua list_windows, select an explicit pid/window_id, then use get_window_state in vision mode.",
      "Use screenshot coordinates for trope_cua actions and verify every mutation with a fresh get_window_state screenshot.",
      "Never use trope_cua on Zen Private Browsing windows unless the user explicitly requests it.",
      "Treat trope_cua receipts as claims, not proof; verify the resulting pixels after click, typing, key, and scroll actions.",
    ],
    renderShell: "self",
    renderCall(args, theme, context) {
      const title =
        theme.fg("toolTitle", theme.bold("trope_cua ")) +
        theme.fg("accent", args.tool ?? "operation");
      return closedToolFrameTop(title, toolFrameStatus(context), theme);
    },
    renderResult(result, options, theme, context) {
      const status = toolFrameStatus(context);
      const container = new Container();
      for (const block of result.content) {
        if (block.type === "text") {
          container.addChild(
            new Text(theme.fg("toolOutput", block.text), 0, 0),
          );
        } else if (block.type === "image") {
          container.addChild(
            new Image(
              block.data,
              block.mimeType,
              { fallbackColor: (text) => theme.fg("dim", text) },
              {
                maxWidthCells: 100,
                maxHeightCells: 30,
              },
            ),
          );
        }
      }
      const label = context.isError
        ? theme.fg("error", "failed")
        : options.isPartial
          ? theme.fg("warning", "running")
          : theme.fg("success", "done");
      return closedToolFrameResult(container, status, theme, label);
    },
    parameters: schema,
    async execute(_toolCallId, params: TropeParams, signal) {
      assertInstalled();
      validateTropeTarget(params);
      const args = params.args ?? {};
      if (WINDOW_TARGET_TOOLS.has(params.tool)) {
        await rejectPrivateWindow(args, signal);
      }
      const result = await invoke(params.tool, args, signal);
      const bounded = boundTropeResult(result);
      const owner = daemonState.owners.get(ownerToken)!;
      if (owner.usedBytes + bounded.outputBytes > SESSION_OUTPUT_MAX_BYTES) {
        throw new Error(
          "Trope CUA session output limit reached; start a new Pi session before capturing more GUI output.",
        );
      }
      owner.usedBytes += bounded.outputBytes;
      if (result.isError) {
        const message =
          bounded.content.find((block) => block.type === "text")?.text ??
          `${params.tool} failed`;
        throw new Error(message);
      }
      return {
        content: bounded.content.length
          ? bounded.content
          : [{ type: "text" as const, text: `${params.tool}: ok` }],
        details: { tool: params.tool, ...bounded.details },
      };
    },
  });

  pi.on("session_start", () => {
    sessionActive = true;
    acquireOwner();
    const active = pi
      .getActiveTools()
      .filter((name) => !name.startsWith("computer_"));
    if (!active.includes("trope_cua")) active.push("trope_cua");
    pi.setActiveTools(active);
  });

  pi.on("session_shutdown", async () => {
    if (!sessionActive) return;
    sessionActive = false;
    daemonState.owners.delete(ownerToken);
    if (
      daemonState.owners.size > 0 ||
      !daemonState.started ||
      (isAbsolute(exe) && !existsSync(exe))
    ) {
      return;
    }
    daemonState.stopping ??= pi
      .exec(exe, ["stop", "--instance", daemonState.instance], {
        timeout: 5_000,
      })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        daemonState.started = false;
        daemonState.stopping = undefined;
      });
    await daemonState.stopping;
  });
}
