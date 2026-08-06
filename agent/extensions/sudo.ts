import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import {
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

class PasswordPrompt implements Component {
  private password = "";

  constructor(
    private readonly command: string,
    private readonly theme: any,
    private readonly requestRender: () => void,
    private readonly done: (value: string | null) => void,
  ) {}

  invalidate() {}

  handleInput(data: string) {
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.password = "";
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const password = this.password;
      this.password = "";
      this.done(password);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.password = Array.from(this.password).slice(0, -1).join("");
      this.requestRender();
      return;
    }
    // Terminal paste may deliver several printable characters at once.
    const printable = Array.from(data).filter((c) => c >= " " && c !== "\x7f").join("");
    if (printable) {
      this.password += printable;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 4);
    const title = this.theme.fg("warning", this.theme.bold("sudo authentication"));
    const cmd = this.theme.fg("muted", this.command.replace(/\s+/g, " "));
    const bullets = "•".repeat(Array.from(this.password).length);
    const pad = (value: string) => {
      const clipped = truncateToWidth(value, inner);
      return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    };
    return [
      this.theme.fg("warning", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
      `│ ${pad(title)} │`,
      `│ ${pad(cmd)} │`,
      `│ ${pad(`Password: ${bullets}█`)} │`,
      `│ ${pad(this.theme.fg("dim", "Enter to authenticate · Esc to cancel"))} │`,
      this.theme.fg("warning", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }
}

export default function sudoExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sudo_exec",
    label: "sudo",
    description:
      "Run a command as root after explicit user confirmation and a secure TUI password prompt. Use only when administrator privileges are required.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run as root" }),
    }),
    renderShell: "self",

    renderCall(args, theme) {
      const command = args.command.replace(/\s+/g, " ");
      return new Text(
        theme.fg("warning", "╭── ") +
          theme.fg("toolTitle", theme.bold("sudo ")) +
          theme.fg("warning", command) +
          theme.fg("warning", " ──"),
        0,
        0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const details = result.details as { exitCode?: number; cancelled?: boolean } | undefined;
      const colour = details?.cancelled || (details?.exitCode ?? 0) !== 0 ? "error" : "warning";
      const body = output
        .split("\n")
        .map((line) => `${theme.fg(colour, "│")} ${line}`)
        .join("\n");
      if (isPartial) return new Text(`${body}\n${theme.fg("warning", "│ running…")}`, 0, 0);
      const status = details?.cancelled ? "cancelled" : `exit ${details?.exitCode ?? 0}`;
      return new Text(`${body}${body ? "\n" : ""}${theme.fg(colour, `╰── ${status} ──`)}`, 0, 0);
    },

    async execute(_id, params, signal, onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "sudo_exec requires Pi's interactive TUI." }],
          details: { cancelled: true },
          isError: true,
        };
      }

      const password = await ctx.ui.custom<string | null>(
        (tui, theme, _keys, done) =>
          new PasswordPrompt(params.command, theme, () => tui.requestRender(), done),
        {
          overlay: true,
          overlayOptions: { width: "70%", minWidth: 42, maxHeight: 7, anchor: "center" },
        },
      );

      if (password === null) {
        return {
          content: [{ type: "text", text: "Root command cancelled by user." }],
          details: { cancelled: true },
        };
      }

      return await new Promise<any>((resolve) => {
        const child = spawn("sudo", ["-S", "-p", "", "/bin/bash", "-lc", params.command], {
          cwd: ctx.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        let settled = false;
        const update = (chunk: Buffer) => {
          output += chunk.toString();
          onUpdate?.({ content: [{ type: "text", text: output }], details: {} });
        };
        child.stdout.on("data", update);
        child.stderr.on("data", update);
        child.stdin.end(`${password}\n`);

        const abort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          resolve({ content: [{ type: "text", text: error.message }], details: { exitCode: 1 }, isError: true });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          const exitCode = code ?? 1;
          resolve({
            content: [{ type: "text", text: output.trim() || `Command exited with code ${exitCode}.` }],
            details: { exitCode },
            isError: exitCode !== 0,
          });
        });
      });
    },
  });
}
