import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TOOLS = [
  "list_windows", "list_apps", "get_window_state", "screenshot", "zoom",
  "find_element", "click", "right_click", "double_click", "type_text",
  "type_text_chars", "set_value", "press_key", "hotkey", "scroll",
  "launch_app", "get_screen_size", "get_cursor_position", "move_cursor",
  "get_agent_cursor_state",
] as const;

const WINDOW_TARGET_TOOLS = new Set([
  "get_window_state", "zoom", "find_element", "click", "right_click",
  "double_click", "type_text", "type_text_chars", "set_value", "press_key",
  "hotkey", "scroll",
]);

const schema = Type.Object({
  tool: StringEnum(TOOLS, { description: "Trope CUA operation to invoke." }),
  args: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "Arguments for the selected Trope CUA operation. Use explicit pid and window_id for window actions.",
  })),
});

type TropeParams = {
  tool: (typeof TOOLS)[number];
  args?: Record<string, unknown>;
};

type TropeBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type TropeResult = {
  content?: TropeBlock[];
  isError?: boolean;
  structuredContent?: unknown;
};

export default function tropeCuaExtension(pi: ExtensionAPI) {
  process.env.TROPE_CUA_JSON = "1";
  const exe = join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "TropeCUA",
    "trope-cua.exe",
  );
  const instance = `pi-${process.pid}`;
  let daemonStarted = false;

  function startDaemon() {
    if (daemonStarted || !existsSync(exe)) return;
    const child = spawn(exe, ["serve", "--instance", instance], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TROPE_CUA_JSON: "1" },
    });
    child.unref();
    daemonStarted = true;
  }

  async function invoke(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<TropeResult> {
    startDaemon();
    let last = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await pi.exec(
        exe,
        ["call", "--instance", instance, tool, JSON.stringify(args)],
        {
          signal,
          timeout: 120_000,
        },
      );
      last = result.stdout || result.stderr;
      if (result.code === 0 && result.stdout.trim()) {
        return JSON.parse(result.stdout) as TropeResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(last.trim() || `Trope CUA ${tool} failed`);
  }

  async function rejectPrivateWindow(args: Record<string, unknown>, signal?: AbortSignal) {
    const windowId = args.window_id;
    if (typeof windowId !== "number") return;
    const pid = typeof args.pid === "number" ? args.pid : undefined;
    const result = await invoke("list_windows", {
      ...(pid === undefined ? {} : { pid }),
      verbose: true,
    }, signal);
    const windows = (result.structuredContent as { windows?: Array<{ window_id?: number; title?: string }> } | undefined)?.windows ?? [];
    const target = windows.find((window) => window.window_id === windowId);
    if (target?.title?.toLowerCase().includes("private browsing")) {
      throw new Error("Refusing to inspect or interact with a private-browsing window.");
    }
  }

  pi.registerTool({
    name: "trope_cua",
    label: "Trope CUA",
    description: "Inspect and operate Windows apps through Trope CUA. Use vision screenshots by default. Supported operations include window/app discovery, screenshots, zoom, clicks, typing, keys, scrolling, element lookup, and app launch. Always use explicit pid/window_id, inspect action receipts, and verify mutations with a new screenshot.",
    promptSnippet: "Use Trope CUA for all visible Windows GUI inspection and interaction",
    promptGuidelines: [
      "Use trope_cua instead of computer_* tools for Windows GUI work.",
      "Use trope_cua list_windows, select an explicit pid/window_id, then use get_window_state in vision mode.",
      "Use screenshot coordinates for trope_cua actions and verify every mutation with a fresh get_window_state screenshot.",
      "Never use trope_cua on Zen Private Browsing windows unless the user explicitly requests it.",
      "Treat trope_cua receipts as claims, not proof; verify the resulting pixels after click, typing, key, and scroll actions.",
    ],
    parameters: schema,
    async execute(_toolCallId, params: TropeParams, signal) {
      if (!existsSync(exe)) {
        throw new Error(`Trope CUA is not installed at ${exe}`);
      }
      const args = params.args ?? {};
      if (WINDOW_TARGET_TOOLS.has(params.tool)) {
        await rejectPrivateWindow(args, signal);
      }
      const result = await invoke(params.tool, args, signal);
      const content = (result.content ?? []).map((block) => {
        if (block.type === "image") {
          return { type: "image" as const, data: block.data, mimeType: block.mimeType };
        }
        const text = block.text.length > 50_000
          ? `${block.text.slice(0, 50_000)}\n\n[Output truncated at 50KB]`
          : block.text;
        return { type: "text" as const, text };
      });
      if (result.isError) {
        const message = content.find((block) => block.type === "text")?.text ?? `${params.tool} failed`;
        throw new Error(message);
      }
      return {
        content: content.length ? content : [{ type: "text" as const, text: `${params.tool}: ok` }],
        details: result.structuredContent ?? {},
      };
    },
  });

  pi.on("session_start", (_event) => {
    startDaemon();
    const active = pi.getActiveTools().filter((name) => !name.startsWith("computer_"));
    if (!active.includes("trope_cua")) active.push("trope_cua");
    pi.setActiveTools(active);
  });

  pi.on("session_shutdown", async () => {
    if (!daemonStarted || !existsSync(exe)) return;
    try {
      await pi.exec(exe, ["stop", "--instance", instance], {
        timeout: 5_000,
      });
    } catch {
      // Best-effort cleanup; stale daemon records self-heal on the next listing.
    }
  });
}
