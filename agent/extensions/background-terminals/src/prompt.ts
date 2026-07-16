import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../../shared/terminal-text.ts";
import {
  formatElapsed,
  formatExit,
  type OutputView,
  type TerminalSnapshot,
} from "./domain.ts";
import { MAX_RUNNING, type KillResult } from "./manager.ts";

export const STATUS_STDOUT_MAX = 16 * 1024;
export const STATUS_STDERR_MAX = 8 * 1024;
export const RESULT_STDOUT_MAX = 8 * 1024;
export const RESULT_STDERR_MAX = 4 * 1024;

export const BG_START_TOOL_DESCRIPTION =
  "Start a long-running command in native PowerShell 7 on Windows. It is spawned directly as pwsh.exe -NoLogo -NoProfile -NonInteractive -Command <wrapper>, receives no stdin, and is killed when this Pi session reloads, switches, forks, or exits. " +
  `Returns immediately and reports completion exactly once. Status output is tail-bounded (stdout ${formatSize(STATUS_STDOUT_MAX)}, stderr ${formatSize(STATUS_STDERR_MAX)}); raw capture uses a bounded memory tail plus bounded rotating disk spill. Max ${MAX_RUNNING} running terminals.`;

export const BG_START_PROMPT_SNIPPET =
  "Run a long-lived native PowerShell 7 command in the background; output is captured and completion is delivered automatically";

export const BG_START_PROMPT_GUIDELINES = [
  "Use bg_start for commands expected to run long or indefinitely; use bash for quick commands.",
  "bg_start processes receive no stdin, so never use bg_start for interactive commands.",
  "After bg_start, continue other work; use bg_status only when current output is needed before completion.",
];

export const BG_START_PARAMETER_DESCRIPTIONS = {
  command:
    "PowerShell 7 command text. Pipelines and $env:NAME expansion are supported; stdin is immediate EOF.",
  title: "Short human-readable title for listings",
  workingDir: "Working directory, resolved from Pi's current directory",
};

export const BG_STATUS_TOOL_DESCRIPTION =
  "Read one background terminal's state and bounded, sanitized stdout/stderr tails.";
export const BG_LIST_TOOL_DESCRIPTION =
  "List session-scoped background terminals, including settled entries.";
export const BG_KILL_TOOL_DESCRIPTION =
  "Stop terminal process trees with awaited taskkill /T and /T /F escalation, then report the observed final state.";

function oneLine(text: string): string {
  return sanitizeTerminalText(text).replaceAll("\n", " ").trim();
}

function spillDescription(view: OutputView): string {
  if (!view.spillDirectory) return "disk spill unavailable";
  const parts = [
    `spill ${view.spillDirectory}`,
    `${view.spillFiles.length} file${view.spillFiles.length === 1 ? "" : "s"}`,
    `${formatSize(view.spillRetainedBytes)} retained`,
    `${view.spillRotations} rotation${view.spillRotations === 1 ? "" : "s"}`,
  ];
  if (view.spillDroppedBytes > 0)
    parts.push(`${formatSize(view.spillDroppedBytes)} rotated out`);
  if (view.spillError) parts.push(`incomplete: ${oneLine(view.spillError)}`);
  else if (view.spillComplete) parts.push("complete");
  else parts.push("bounded/truncated");
  return parts.join(", ");
}

export function buildStartResult(snapshot: TerminalSnapshot): string {
  return `Started ${snapshot.id} "${oneLine(snapshot.title)}" (pid ${snapshot.pid ?? "?"}, ${oneLine(snapshot.cwd)}) in native PowerShell 7.\nNo stdin is available. Completion will be reported once; use bg_status, bg_list, or bg_kill meanwhile.`;
}

export function describeTerminal(snapshot: TerminalSnapshot): string {
  return `${snapshot.id} [${snapshot.status}] "${oneLine(snapshot.title)}" (pid ${snapshot.pid ?? "?"}, ${formatElapsed(snapshot)}, ${formatExit(snapshot)}, stdout ${formatSize(snapshot.stdout.totalBytes)}, stderr ${formatSize(snapshot.stderr.totalBytes)}, ${oneLine(snapshot.cwd)})`;
}

function outputSection(
  label: string,
  view: OutputView,
  maxBytes: number,
  maxLines: number,
): string {
  if (view.totalBytes === 0)
    return `${label}: (empty)\n[${spillDescription(view)}]`;
  const safe = sanitizeTerminalText(view.text);
  const truncated = truncateTail(safe, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(maxLines, DEFAULT_MAX_LINES),
  });
  const memoryNote =
    view.truncatedBytes > 0
      ? `${formatSize(view.truncatedBytes)} dropped from the in-memory head`
      : "memory tail complete";
  return `${label}:\n${truncated.content}\n[showing a bounded tail of ${formatSize(view.totalBytes)} raw bytes; ${memoryNote}; ${spillDescription(view)}]`;
}

export function buildStatusResult(snapshot: TerminalSnapshot): string {
  let result = describeTerminal(snapshot);
  if (snapshot.errorText) result += `\nNote: ${oneLine(snapshot.errorText)}`;
  result += `\n\n${outputSection("stdout", snapshot.stdout, STATUS_STDOUT_MAX, 400)}`;
  result += `\n\n${outputSection("stderr", snapshot.stderr, STATUS_STDERR_MAX, 200)}`;
  return result;
}

export function buildTerminalResultMessage(snapshot: TerminalSnapshot): string {
  const action =
    snapshot.status === "killed"
      ? "was killed"
      : `exited (${formatExit(snapshot)})`;
  let result = `Background terminal ${snapshot.id} "${oneLine(snapshot.title)}" ${action} after ${formatElapsed(snapshot)}.`;
  if (snapshot.errorText) result += `\nNote: ${oneLine(snapshot.errorText)}`;
  result += `\n\n${outputSection("stdout", snapshot.stdout, RESULT_STDOUT_MAX, 40)}`;
  if (snapshot.stderr.totalBytes > 0)
    result += `\n\n${outputSection("stderr", snapshot.stderr, RESULT_STDERR_MAX, 20)}`;
  return result;
}

export function buildKillReport(results: readonly KillResult[]): string {
  return results
    .map((result) => {
      const helper = result.helpers
        .map((item) => `${item.force ? "/T /F" : "/T"}: ${item.classification}`)
        .join(", ");
      if (result.killed)
        return `Killed ${result.id} "${oneLine(result.title)}" (${result.exit}; ${helper || "no helper"}).`;
      if (result.wasRunning)
        return `${result.id} "${oneLine(result.title)}" settled naturally or could not be confirmed killed (${result.exit}; ${helper || "no helper"}).`;
      return `${result.id} "${oneLine(result.title)}" was already ${result.status} (${result.exit}).`;
    })
    .join("\n");
}
