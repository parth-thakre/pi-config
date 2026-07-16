import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  base: "Git base for the workflow worktree. Defaults to freshly fetched origin/main. Use HEAD, a local branch, commit, tag, or origin/<branch> only when the user asks for a different base.",
  background:
    "TUI only: return the run id immediately and deliver typed follow-up completion. Defaults to true in TUI. Outside TUI execution is blocking and background:true is rejected.",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "The workflow tool is only to be called when the user says 'ultracode' or specifically requests a workflow run.",
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines). Each run gets one locked Git worktree based on freshly fetched origin/main unless the user explicitly requests another base.",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort?, readOnly? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. `readOnly:true` is an explicit promise that the task only needs read/grep/find/ls; those agents may fan out. All other agents are writer-exclusive and never overlap. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Children use the run's single worktree and trust-appropriate resources, but cannot recursively orchestrate or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. Concurrency is globally capped at 4 for the run.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. A run may make at most 32 agent calls and has no overall deadline. Each agent must produce its first provider response within 45 seconds; after that it has no overall wall-clock deadline. Each individual child tool call times out independently after 3 minutes, becomes an error tool result, and leaves the agent loop free to recover. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. There is no resume: a failed run is simply re-run. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const scans = await parallel(args.files.map((f) => () => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "return { findings, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/parallel() with structured outputs and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`.",
  "Omit the workflow base by default so the run starts from freshly fetched origin/main. Set base only when the user explicitly requests another ref.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if (details.worktreePath)
    lines.push(`Worktree: ${shortenHome(details.worktreePath)}`);
  if (details.branch) lines.push(`Branch: ${details.branch}`);
  if (details.baseRef) lines.push(`Base: ${details.baseRef}`);
  if (details.baseCommit) lines.push(`Base commit: ${details.baseCommit}`);
  if (details.finalHead) lines.push(`Final HEAD: ${details.finalHead}`);
  if (details.dirtySummary)
    lines.push(`Worktree status: ${details.dirtySummary}`);
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
  worktreePath?: string;
  branch?: string;
  baseRef?: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    ...(options.worktreePath
      ? [`Worktree: ${shortenHome(options.worktreePath)}`]
      : []),
    ...(options.branch ? [`Branch: ${options.branch}`] : []),
    ...(options.baseRef ? [`Base: ${options.baseRef}`] : []),
    "You'll receive a typed follow-up when it finishes; /workflows shows progress.",
  ].join("\n");
}
