export type TerminalStatus = "running" | "done" | "failed" | "killed";

export interface OutputView {
  /** Raw decoded tail. Sanitization belongs at display boundaries. */
  readonly text: string;
  readonly totalBytes: number;
  readonly truncatedBytes: number;
  readonly spillDirectory?: string;
  readonly spillFiles: readonly string[];
  readonly spillRetainedBytes: number;
  readonly spillDroppedBytes: number;
  readonly spillRotations: number;
  readonly spillComplete: boolean;
  readonly spillError?: string;
}

export interface TerminalSnapshot {
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  readonly pid?: number;
  readonly status: TerminalStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorText?: string;
  readonly stdout: OutputView;
  readonly stderr: OutputView;
}

export interface TerminalSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  readonly elapsed: string;
}

export function formatElapsed(
  snapshot: Pick<TerminalSnapshot, "createdAt" | "settledAt">,
): string {
  const seconds = Math.max(
    0,
    Math.round(
      ((snapshot.settledAt ?? Date.now()) - snapshot.createdAt) / 1000,
    ),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${rest.toString().padStart(2, "0")}s`;
  return `${rest}s`;
}

export function formatExit(snapshot: TerminalSnapshot): string {
  if (snapshot.status === "running") return "running";
  if (snapshot.signal) return snapshot.signal;
  if (snapshot.exitCode !== undefined) return `exit ${snapshot.exitCode}`;
  return snapshot.status;
}

export function terminalSummary(snapshot: TerminalSnapshot): TerminalSummary {
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    elapsed: formatElapsed(snapshot),
  };
}
