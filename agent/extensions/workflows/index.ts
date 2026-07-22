/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort?, readOnly? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * TUI runs are autonomous background jobs by default. Headless runs are
 * explicitly blocking because this extension has no durable worker. Run
 * artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { createDelegatedCostAccounting } from "../shared/delegated-cost.ts";
import {
  closedToolFrame,
  closedToolFrameResult,
  closedToolFrameText,
  closedToolFrameTop,
  toolFrameStatus,
} from "../shared/closed-tool-frame.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import {
  WORKFLOW_COMPLETION_MESSAGE_TYPE,
  createCompletionDelivery,
  markWorkflowJobRegistered,
  markWorkflowJobUnregistered,
  recoverInterruptedWorkflowJobs,
  resolveWorkflowBackgroundMode,
} from "./jobs.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import {
  cleanupWorkflowWorktree,
  createWorkflowWorktree,
  preflightWorkflowRepository,
  summarizeWorkflowWorktree,
  validateWorkflowWorktreeForCleanup,
  type GitExec,
} from "./worktree.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  readOnly?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  base: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.base,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function displayText(value: unknown) {
  return sanitizeTerminalText(
    typeof value === "string" ? value : String(value ?? ""),
  );
}

function displayLine(value: unknown) {
  return displayText(value).replaceAll("\n", " ");
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  const delegatedCost = createDelegatedCostAccounting(pi);
  const accountedRuns = new Set<string>();

  const accountRunCost = (details: WorkflowDetails) => {
    if (accountedRuns.has(details.runId)) return;
    accountedRuns.add(details.runId);
    delegatedCost.add(aggregateUsage(details.agents).cost);
  };

  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    {
      details: WorkflowDetails;
      controller: RunController;
      completion?: Promise<void>;
    }
  >();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let sessionClosing = false;
  let completedRuns = 0;
  let failedRuns = 0;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionClosing = false;
    if (ctx.hasUI) lastUi = ctx.ui;
    recoverInterruptedWorkflowJobs(path.join(getAgentDir(), "workflows"));
    updateIndicator();
  });

  pi.registerMessageRenderer(
    WORKFLOW_COMPLETION_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details as
        { status?: string; name?: string; runId?: string } | undefined;
      const success = details?.status === "completed";
      const tone = success ? "success" : "error";
      const title =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", details?.name ?? details?.runId ?? "completed");
      const body = new Text(
        theme.fg(
          tone,
          displayText(
            typeof message.content === "string"
              ? message.content
              : "Workflow job settled",
          ),
        ),
        0,
        0,
      );
      return closedToolFrame(
        title,
        body,
        success ? "success" : "error",
        theme,
        theme.fg(tone, success ? "completed" : "failed"),
      );
    },
  );

  pi.on("session_shutdown", async () => {
    sessionClosing = true;
    const runs = [...activeRuns.values()];
    for (const run of runs) {
      run.details.lifecycle = "interrupted";
      run.details.error =
        run.details.error ??
        "Pi session shut down while the workflow was running";
      persistWorkflowJson(
        path.join(getAgentDir(), "workflows", run.details.runId),
        run.details,
      );
      run.controller.abort("Session is shutting down");
    }
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
    accountedRuns.clear();
  });

  pi.registerCommand("workflows", {
    description:
      "Manage workflow jobs: list, status <id>, cancel <id>, cleanup <id>",
    handler: async (rawArgs, ctx) => {
      const [verb = "dashboard", requestedId] = rawArgs.trim().split(/\s+/, 2);
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      const resolveRun = (id?: string) =>
        id
          ? runs.find((run) => run.runId === id || run.runId.endsWith(id))
          : undefined;

      if (verb === "cancel") {
        const run = resolveRun(requestedId);
        if (!run) {
          ctx.ui.notify(
            `Unknown workflow run: ${displayLine(requestedId ?? "(missing)")}`,
            "warning",
          );
          return;
        }
        const active = activeRuns.get(run.runId);
        if (!active) {
          ctx.ui.notify(
            `Workflow ${run.runId} is already ${run.status}.`,
            "info",
          );
          return;
        }
        active.controller.abort("Workflow cancelled by user");
        ctx.ui.notify(
          `Cancelling ${run.runId}; retained worktree will not be deleted.`,
          "info",
        );
        return;
      }

      if (verb === "cleanup") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Workflow cleanup is unavailable headlessly.",
            "warning",
          );
          return;
        }
        const run = resolveRun(requestedId);
        if (!run) {
          ctx.ui.notify(
            `Unknown workflow run: ${displayLine(requestedId ?? "(missing)")}`,
            "warning",
          );
          return;
        }
        const runDir = path.join(getAgentDir(), "workflows", run.runId);
        const details =
          activeRuns.get(run.runId)?.details ??
          (JSON.parse(
            fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
          ) as WorkflowDetails);
        if (details.status === "running") {
          ctx.ui.notify("Refusing to clean up a running workflow.", "warning");
          return;
        }
        if (
          !details.repoRoot ||
          !details.commonGitDir ||
          !details.baseCommit ||
          !details.branch ||
          !details.worktreePath
        ) {
          ctx.ui.notify(
            "This run has no managed worktree metadata.",
            "warning",
          );
          return;
        }
        let cleanupIdentity;
        try {
          cleanupIdentity = await validateWorkflowWorktreeForCleanup({
            exec: ((_command, argv, options) =>
              pi.exec("git", argv, options)) as GitExec,
            record: details as Required<
              Pick<
                WorkflowDetails,
                | "repoRoot"
                | "commonGitDir"
                | "baseCommit"
                | "branch"
                | "worktreePath"
              >
            >,
          });
        } catch (error) {
          ctx.ui.notify(displayText(errorText(error)), "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Permanently delete retained workflow branch?",
          `${displayLine(details.worktreePath)}\nBranch: ${displayLine(details.branch)}\nBase HEAD: ${displayLine(details.baseCommit)}\nCurrent HEAD: ${displayLine(cleanupIdentity.currentHead)}\n\nThis removes the clean worktree and irreversibly force-deletes the branch, including commits not referenced elsewhere.`,
        );
        if (!confirmed) return;
        try {
          await cleanupWorkflowWorktree({
            exec: ((_command, argv, options) =>
              pi.exec("git", argv, options)) as GitExec,
            record: { ...details, status: details.status } as Required<
              Pick<
                WorkflowDetails,
                | "repoRoot"
                | "commonGitDir"
                | "baseCommit"
                | "branch"
                | "worktreePath"
              >
            > & { status: string },
            expectedHead: cleanupIdentity.currentHead,
          });
          details.lifecycle = "cleaned";
          persistWorkflowJson(runDir, details);
          ctx.ui.notify(`Cleaned ${run.runId}.`, "info");
        } catch (error) {
          ctx.ui.notify(displayText(errorText(error)), "warning");
        }
        return;
      }

      if (verb === "status" || (verb.startsWith("wf_") && !requestedId)) {
        const run = resolveRun(verb === "status" ? requestedId : verb);
        ctx.ui.notify(
          displayText(
            run
              ? runDetailText(run, activeDetails())
              : `Unknown workflow run: ${requestedId ?? verb}`,
          ),
          run ? "info" : "warning",
        );
        return;
      }

      if (ctx.mode === "tui" && verb !== "list") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, undefined);
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      ctx.ui.notify(
        runs
          .map(
            (run) =>
              `${run.active ? "* " : "  "}${displayLine(run.runId)}  ${displayLine(run.status)}  ${displayLine(run.name ?? "")}  ${run.done}/${run.total}`,
          )
          .join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const background = resolveWorkflowBackgroundMode(
        ctx.mode,
        params.background,
      );
      const gitExec = ((_command, argv, options) =>
        pi.exec("git", argv, options)) as GitExec;
      const launchSignal = background ? undefined : signal;
      // Gate 1: repository identity, freshly fetched default base, and parent
      // cleanliness are established before script preparation or child startup.
      const repository = await preflightWorkflowRepository({
        exec: gitExec,
        cwd: ctx.cwd,
        base: params.base,
        signal: launchSignal,
      });

      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      // Gate 2: create exactly one locked worktree from the preflight snapshot.
      const worktree = await createWorkflowWorktree({
        exec: gitExec,
        cwd: ctx.cwd,
        runId,
        worktreeBaseDir: path.join(getAgentDir(), "wt"),
        signal: launchSignal,
        repository,
      });
      const workflowCwd = worktree.worktreePath;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        ownerPid: process.pid,
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        lifecycle: "prepared",
        startedAt: Date.now(),
        ...worktree,
        phases: [...meta.phases],
        agents: [],
      };

      // The validated identity and prepared lifecycle are the first durable
      // run record, before the sandbox, resources, settings, SessionManager,
      // or any agent is created. Every failure after worktree creation leaves
      // that branch/path retained and records a terminal launch failure when
      // storage is still writable.
      let persistence: ReturnType<typeof createWorkflowPersistence>;
      try {
        persistWorkflowJson(runDir, details);
        writeRunFile(runDir, "script.js", params.script);
        if (params.args !== undefined)
          writeRunFile(runDir, "args.json", params.args);
        persistence = createWorkflowPersistence(runDir, details);
        details.lifecycle = "running";
        persistence.checkpoint({ immediate: true });
      } catch (error) {
        details.status = "failed";
        details.lifecycle = "failed";
        details.finishedAt = Date.now();
        details.error = `Workflow launch failed before job registration: ${errorText(error)}`;
        try {
          persistWorkflowJson(runDir, details);
        } catch {
          // The original persistence failure is authoritative.
        }
        throw new Error(
          `${details.error}\nRetained worktree: ${worktree.worktreePath}\nRetained branch: ${worktree.branch}\nNo cleanup was attempted.`,
          { cause: error },
        );
      }

      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const controller = new RunController(background ? undefined : signal);

      // Trust inheritance is evaluated only after common-directory and base
      // HEAD validation by createWorkflowWorktree().
      const projectTrusted = ctx.isProjectTrusted();
      const getResources = (structured: boolean) =>
        createWorkflowResources(
          workflowCwd,
          structured ? "structured" : "plain",
          projectTrusted,
        );

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        lastEmit = Date.now();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          readOnly: opts.readOnly === true,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt = buildWorkflowAgentPrompt(
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? ""),
        );
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        return controller
          .schedule(
            async (runSignal) => {
              // Model/provider resolution: default to the parent session's model.
              let model: WorkflowModel | undefined = ctx.model;
              if (opts.model !== undefined || opts.provider !== undefined) {
                const modelOpt =
                  typeof opts.model === "string" ? opts.model : undefined;
                const providerOpt =
                  typeof opts.provider === "string" ? opts.provider : undefined;
                if (!modelOpt)
                  return fail(
                    `agent "${label}": \`provider\` requires \`model\` as well`,
                  );
                let resolved: WorkflowModel | undefined;
                if (providerOpt) {
                  resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
                } else {
                  const slash = modelOpt.indexOf("/");
                  if (slash > 0) {
                    resolved = ctx.modelRegistry.find(
                      modelOpt.slice(0, slash),
                      modelOpt.slice(slash + 1),
                    );
                  }
                  resolved ??= ctx.modelRegistry
                    .getAll()
                    .find((m) => m.id === modelOpt);
                }
                if (!resolved) {
                  const requested = providerOpt
                    ? `${providerOpt}/${modelOpt}`
                    : modelOpt;
                  return fail(
                    `agent "${label}": unknown model "${requested}" (use provider/id)`,
                  );
                }
                model = resolved;
              }
              record.model = model?.id;
              record.contextWindow = model?.contextWindow;
              emit();

              // Effort → thinking level; default inherits the parent session.
              let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
              if (opts.effort !== undefined) {
                const effort = String(opts.effort);
                if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
                  return fail(
                    `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
                  );
                }
                thinkingLevel = effort as ThinkingLevel;
              }

              const resources = await getResources(opts.schema !== undefined);
              const outcome = await runAgent({
                prompt,
                schema: opts.schema,
                model,
                thinkingLevel,
                cwd: workflowCwd,
                loader: resources.loader,
                settingsManager: resources.settingsManager,
                modelRegistry: ctx.modelRegistry,
                signal: runSignal,
                readOnly: record.readOnly,
                onProgress: (progress) => {
                  record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                  record.usage = progress.usage;
                  record.model = progress.model ?? record.model;
                  record.contextWindow =
                    progress.contextWindow ?? record.contextWindow;
                  record.transcript = progress.transcript;
                  emit();
                },
              });

              record.usage = outcome.usage;
              record.model = outcome.model ?? record.model;
              record.contextWindow =
                outcome.contextWindow ?? record.contextWindow;
              record.transcript = outcome.transcript;
              record.preview = (outcome.output || record.preview).slice(
                0,
                PREVIEW_LENGTH,
              );
              record.finishedAt = Date.now();
              record.state = outcome.ok ? "done" : "error";
              if (outcome.ok) {
                delete record.error;
              } else {
                record.error = outcome.error ?? "Agent failed";
              }
              emit();

              return {
                ok: outcome.ok,
                output: outcome.output,
                ...(outcome.structured !== undefined
                  ? { structured: outcome.structured }
                  : {}),
                ...(outcome.error !== undefined
                  ? { error: outcome.error }
                  : {}),
              };
            },
            invocationSignal,
            record.readOnly ? "read" : "write",
          )
          .catch((error) => fail(errorText(error)));
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: workflowCwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
          });
        } catch (error) {
          details.error = errorText(error);
          status = controller.signal.aborted ? "aborted" : "failed";
          controller.abort("Workflow script failed");
        }

        const settled = await controller.settle({
          abort: status !== "completed",
        });
        if (!settled) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        details.status = status;
        details.lifecycle =
          details.lifecycle === "interrupted"
            ? "interrupted"
            : status === "completed"
              ? "completed"
              : status === "aborted"
                ? "aborted"
                : "failed";
        details.finishedAt = Date.now();
        try {
          const summary = await summarizeWorkflowWorktree({
            exec: gitExec,
            worktreePath: workflowCwd,
          });
          details.finalHead = summary.finalHead;
          details.dirtySummary = summary.dirtySummary;
        } catch (error) {
          details.dirtySummary = `unavailable: ${errorText(error)}`;
        }
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          flushNow();
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun = { details, controller } as {
        details: WorkflowDetails;
        controller: RunController;
        completion?: Promise<void>;
      };
      activeRuns.set(runId, activeRun);
      markWorkflowJobRegistered(runId);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        const deliverCompletion = createCompletionDelivery(() => {
          pi.sendMessage(
            {
              customType: WORKFLOW_COMPLETION_MESSAGE_TYPE,
              content: buildBackgroundWorkflowFollowUp({
                runId,
                status: details.status,
                result: buildWorkflowResultMessage(details, runDir),
              }),
              display: true,
              details: {
                runId,
                status: details.status,
                worktreePath: details.worktreePath,
                branch: details.branch,
                baseRef: details.baseRef,
                baseCommit: details.baseCommit,
                finalHead: details.finalHead,
                dirtySummary: details.dirtySummary,
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });
        void completion
          .catch((error) => {
            details.status = "failed";
            details.lifecycle = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
            persistWorkflowJson(runDir, details);
          })
          .finally(() => {
            activeRuns.delete(runId);
            markWorkflowJobUnregistered(runId);
            accountRunCost(details);
            recordSettledRun(details.status);
            updateIndicator();
            if (!sessionClosing) {
              try {
                deliverCompletion();
              } catch {
                // The durable record remains authoritative if delivery fails.
              }
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
                worktreePath: details.worktreePath,
                branch: details.branch,
                baseRef: details.baseRef,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        activeRuns.delete(runId);
        markWorkflowJobUnregistered(runId);
        accountRunCost(details);
        recordSettledRun(details.status);
        updateIndicator();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
      };
    },

    renderShell: "self",

    renderCall(args: Partial<WorkflowInput>, theme, context) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      const title =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg(
          "accent",
          displayLine((meta as WorkflowMeta).name ?? "(script)"),
        ) +
        (args.background ? theme.fg("dim", " (background)") : "");
      const rows: string[] = [];
      const description = (meta as WorkflowMeta).description;
      if (description)
        rows.push(` ${theme.fg("dim", displayText(description))}`);
      for (const phase of meta.phases.slice(0, 8)) {
        rows.push(
          ` ${theme.fg("dim", SQUARE)} ${theme.fg("accent", displayLine(phase.title))}${
            phase.detail
              ? theme.fg("dim", ` · ${displayLine(phase.detail)}`)
              : ""
          }`,
        );
      }
      return closedToolFrameTop(title, toolFrameStatus(context), theme, rows);
    },

    renderResult(result, { expanded }, theme, context) {
      const status = toolFrameStatus(context);
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return closedToolFrameText(
          displayText(first?.type === "text" ? first.text : "(no output)"),
          status,
          theme,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", displayLine(details.name ?? details.runId))} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${displayLine(details.currentPhase)}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", displayLine(agent.label))}${
            agent.phase ? theme.fg("dim", ` (${displayLine(agent.phase)})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${displayText(details.error)}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return closedToolFrameText(
          text,
          status,
          theme,
          theme.fg(
            "dim",
            `${settled}/${details.agents.length} agents · ${statusWord(details.status)}`,
          ),
        );
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", displayText(details.description)), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("muted", `─── ${displayLine(group.title)} ───`),
            0,
            0,
          ),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", displayLine(agent.label))} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", displayLine(usage))}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(
                `  ${theme.fg("error", displayText(agent.error))}`,
                0,
                0,
              ),
            );
          } else if (agent.preview) {
            const preview = displayText(agent.preview)
              .split("\n")
              .slice(0, 2)
              .join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("error", `Error: ${displayText(details.error)}`),
            0,
            0,
          ),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${displayText(resultJson(details.result))}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return closedToolFrameResult(
        container,
        status,
        theme,
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · ${statusWord(details.status)}`,
        ),
      );
    },
  });
}
