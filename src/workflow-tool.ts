import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  agentStatusToGraphStatus,
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  updateWorkflowGraphNode,
  upsertWorkflowGraphNode,
  type WorkflowSnapshot,
} from "./display.js";
import type { WorkflowAgent } from "./agent.js";
import type { BackgroundWorkflowManager } from "./background.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  foreground: Type.Optional(
    Type.Boolean({
      description:
        "If true, wait for the workflow to finish and return the result inline. Default is false: start a background workflow and return immediately.",
    }),
  ),
  concurrency: Type.Optional(Type.Number({ description: "Maximum concurrent agent() calls. Defaults to runtime heuristic." })),
  tokenBudget: Type.Optional(Type.Number({ description: "Approximate workflow output token budget. When exhausted, further agent() calls fail." })),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
  foreground?: boolean;
  concurrency?: number;
  tokenBudget?: number;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  backgroundManager?: BackgroundWorkflowManager;
  /** Optional test/embed hook for supplying a custom child-agent runner. */
  agent?: Pick<WorkflowAgent, "run">;
}

function resolveWorkflowSessionId(sessionManager: unknown): string | undefined {
  const manager = sessionManager as { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } | undefined;
  return manager?.getSessionFile?.() ?? manager?.getSessionId?.();
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Start a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "By default workflows run in the background and return a run id immediately; pass foreground:true only when the user explicitly wants to wait inline.",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, the default mode is background: call workflow and return the run id to the user; do not wait unless the user explicitly asks for an inline/foreground workflow.",
      "For workflow, pass foreground:true only when the user explicitly asks to block until completion or needs the result in the current assistant turn.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, continuation, cwd, process.cwd(), and budget. continuation is read-only and only exists in workflows started via workflow_extend or workflow_replace_tail. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, agent() retries retryable provider/model failures once by default; override with opts.retry and opts.retryDelayMs, and use opts.fallbackModels for alternate models. Failed agent(), parallel(), or pipeline() branches still return null after retries unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
      "When early results require new follow-up work, prefer workflow_extend to start a linked workflow with read-only continuation context. Use workflow_replace_tail only when a running parent must be cancelled and replaced; never try to mutate a running workflow script.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);

      if (params.foreground !== true && options.backgroundManager) {
        const run = await options.backgroundManager.start({
          script,
          args: params.args,
          cwd: options.cwd ?? ctx.cwd,
          concurrency: params.concurrency ?? options.concurrency,
          tokenBudget: params.tokenBudget,
          sessionId: resolveWorkflowSessionId(ctx.sessionManager),
          agent: options.agent,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Started background workflow ${run.name}.`,
                `Run ID: ${run.id}`,
                `Artifacts: ${run.artifactDir}`,
                `Use /workflow-status ${run.id} or /workflow-result ${run.id} to inspect it.`,
              ].join("\n"),
            },
          ],
          details: {
            mode: "background",
            id: run.id,
            name: run.name,
            artifactDir: run.artifactDir,
            statusPath: run.statusPath,
            outputPath: run.outputPath,
          },
        };
      }

      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal,
          concurrency: params.concurrency ?? options.concurrency,
          tokenBudget: params.tokenBudget,
          agent: options.agent,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onGraphGroupStart(event) {
            recordPhase(event.phase);
            upsertWorkflowGraphNode(snapshot, { id: event.id, kind: event.kind, label: event.label, phase: event.phase, parentId: event.parentId, pipelineCell: event.pipelineCell, status: "running" });
            update();
          },
          onGraphGroupEnd(event) {
            const childFailed = snapshot.graph?.nodes.some((node) => node.parentId === event.id && node.status === "error") ?? false;
            updateWorkflowGraphNode(snapshot, event.id, { status: event.status === "done" && childFailed ? "error" : event.status });
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            const id = snapshot.agents.length + 1;
            const startedAtMs = Date.now();
            snapshot.agents.push({
              id,
              agentRunId: event.agentRunId,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
              graphParentId: event.parentId,
              pipelineCell: event.pipelineCell,
              startedAtMs,
            });
            upsertWorkflowGraphNode(snapshot, {
              id: event.agentRunId,
              kind: "agent",
              label: event.label,
              phase: event.phase,
              parentId: event.parentId,
              pipelineCell: event.pipelineCell,
              status: "running",
              usage: { durationMs: 0 },
            });
            update();
          },
          onAgentToolBudget(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.agentRunId === event.agentRunId);
            if (agent) {
              agent.toolBudget = {
                count: event.count,
                hard: event.hard,
                ...(event.soft !== undefined ? { soft: event.soft } : {}),
                ...(event.type === "soft" ? { softReached: true } : agent.toolBudget?.softReached ? { softReached: true } : {}),
                ...(event.type === "hard" ? { hardExceeded: true, tool: event.tool } : agent.toolBudget?.hardExceeded ? { hardExceeded: true, tool: agent.toolBudget.tool } : {}),
              };
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { usage: { ...(snapshot.graph?.nodes.find((node) => node.id === agent.agentRunId)?.usage ?? {}), toolCount: event.count } });
            }
            update();
          },
          onAgentAttempt(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.agentRunId === event.agentRunId);
            if (agent) {
              agent.attempts ??= [];
              agent.attempts.push({ model: event.model, attempt: event.attempt, status: event.status, ...(event.error ? { error: event.error } : {}) });
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { attempts: agent.attempts, usage: { ...(snapshot.graph?.nodes.find((node) => node.id === agent.agentRunId)?.usage ?? {}), model: event.model } });
            }
            update();
          },
          onAgentSession(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.agentRunId === event.agentRunId);
            if (agent && event.sessionFile) {
              agent.sessionFile = event.sessionFile;
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { sessionFile: event.sessionFile, artifactPath: event.sessionFile });
            }
            update();
          },
          onAgentWorktree(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.agentRunId === event.agentRunId);
            if (agent) {
              agent.worktreePath = event.worktreePath;
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { worktreePath: event.worktreePath });
            }
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.agentRunId === event.agentRunId);
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.error = event.error;
              agent.resultPreview = preview(event.result);
              agent.durationMs = agent.startedAtMs ? Date.now() - agent.startedAtMs : undefined;
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { status: agentStatusToGraphStatus(agent.status), usage: { ...(snapshot.graph?.nodes.find((node) => node.id === agent.agentRunId)?.usage ?? {}), durationMs: agent.durationMs } });
            }
            update();
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
              updateWorkflowGraphNode(snapshot, agent.agentRunId!, { status: "skipped" });
            }
          }
          for (const node of snapshot.graph?.nodes ?? []) {
            if (node.status === "running") node.status = "skipped";
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
