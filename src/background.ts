import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent, WorkflowAgentOptions } from "./agent.js";
import {
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowMeta, type WorkflowRunResult } from "./workflow.js";

export type BackgroundWorkflowStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundWorkflowRun {
  id: string;
  name: string;
  description: string;
  status: BackgroundWorkflowStatus;
  cwd: string;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  artifactDir: string;
  outputPath: string;
  resultPath: string;
  statusPath: string;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: string;
  controller: AbortController;
  settled: Promise<void>;
}

export interface BackgroundWorkflowStartOptions extends WorkflowAgentOptions {
  script: string;
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  session?: Partial<CreateAgentSessionOptions>;
  sessionId?: string;
}

export interface BackgroundWorkflowManagerOptions {
  runsRoot?: string;
  notify?: (message: string, run: BackgroundWorkflowRun) => void | Promise<void>;
}

export interface BackgroundWorkflowManager {
  start(options: BackgroundWorkflowStartOptions): Promise<BackgroundWorkflowRun>;
  list(): BackgroundWorkflowRun[];
  listActiveWork(): Array<{ id: string; sessionId: string }>;
  get(idOrPrefix: string): BackgroundWorkflowRun | undefined;
  cancel(idOrPrefix: string): boolean;
  waitForRun(idOrPrefix: string, timeoutMs?: number): Promise<BackgroundWorkflowRun | undefined>;
  waitForIdle(sessionId?: string, timeoutMs?: number): Promise<void>;
  formatStatus(idOrPrefix?: string): string;
  formatResult(idOrPrefix: string): string;
}

function defaultRunsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "background-workflows", "runs");
}

export function createBackgroundWorkflowManager(
  options: BackgroundWorkflowManagerOptions = {},
): BackgroundWorkflowManager {
  const runs = new Map<string, BackgroundWorkflowRun>();
  const runsRoot = options.runsRoot ?? defaultRunsRoot();

  const persist = async (run: BackgroundWorkflowRun) => {
    await mkdir(run.artifactDir, { recursive: true });
    const { controller: _controller, settled: _settled, ...serializable } = run;
    await writeFile(run.statusPath, JSON.stringify(serializable, null, 2), "utf8");
  };

  const writeResultArtifacts = async (run: BackgroundWorkflowRun) => {
    await mkdir(run.artifactDir, { recursive: true });
    if (run.result) await writeFile(run.resultPath, JSON.stringify(run.result.result, null, 2), "utf8");
    const text = formatRunResult(run);
    await writeFile(run.outputPath, text, "utf8");
  };

  const update = (run: BackgroundWorkflowRun) => {
    run.updatedAt = new Date().toISOString();
    run.snapshot = recomputeWorkflowSnapshot(run.snapshot);
    void persist(run).catch(() => undefined);
  };

  const start = async (startOptions: BackgroundWorkflowStartOptions): Promise<BackgroundWorkflowRun> => {
    const script = startOptions.script.trim();
    const parsed = parseWorkflowScript(script);
    const id = makeRunId(parsed.meta, runsRoot, runs);
    const artifactDir = resolve(runsRoot, id);
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const run: BackgroundWorkflowRun = {
      id,
      name: parsed.meta.name,
      description: parsed.meta.description,
      status: "running",
      cwd: startOptions.cwd ?? process.cwd(),
      ...(startOptions.sessionId ? { sessionId: startOptions.sessionId } : {}),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDir,
      outputPath: join(artifactDir, "output.md"),
      resultPath: join(artifactDir, "result.json"),
      statusPath: join(artifactDir, "status.json"),
      snapshot: createWorkflowSnapshot(parsed.meta),
      controller: new AbortController(),
      settled,
    };
    runs.set(id, run);
    await persist(run);

    void (async () => {
      try {
        const result = await runWorkflow(script, {
          cwd: run.cwd,
          args: startOptions.args,
          concurrency: startOptions.concurrency,
          signal: run.controller.signal,
          agent: startOptions.agent,
          session: startOptions.session,
          onLog(message) {
            run.snapshot.logs.push(message);
            update(run);
          },
          onPhase(title) {
            run.snapshot.currentPhase = title;
            if (!run.snapshot.phases.includes(title)) run.snapshot.phases.push(title);
            update(run);
          },
          onAgentStart(event) {
            if (!run.snapshot.phases.includes(event.phase ?? "") && event.phase) run.snapshot.phases.push(event.phase);
            run.snapshot.agents.push({
              id: run.snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update(run);
          },
          onAgentEnd(event) {
            const agent = [...run.snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
            }
            update(run);
          },
        });
        if (result.agentCount === 0) {
          throw new Error(
            "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
          );
        }
        run.result = result;
        run.status = "completed";
        run.snapshot.result = result.result;
        run.snapshot.durationMs = result.durationMs;
      } catch (error) {
        run.status = run.controller.signal.aborted ? "cancelled" : "failed";
        run.error = error instanceof Error ? error.message : String(error);
        for (const agent of run.snapshot.agents) {
          if (agent.status === "running") {
            agent.status = run.status === "cancelled" ? "skipped" : "error";
            agent.error = run.error;
          }
        }
      } finally {
        run.completedAt = new Date().toISOString();
        update(run);
        await writeResultArtifacts(run).catch(() => undefined);
        await persist(run).catch(() => undefined);
        try {
          await options.notify?.(formatRunResult(run), run);
        } catch {
          // Completion notification is best-effort. Artifacts and status remain available.
        } finally {
          resolveSettled();
        }
      }
    })();

    return run;
  };

  const list = () => [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const listActiveWork = () => list()
    .filter((run) => run.status === "running" && typeof run.sessionId === "string" && run.sessionId.length > 0)
    .map((run) => ({ id: run.id, sessionId: run.sessionId! }));

  const get = (idOrPrefix: string) => {
    if (runs.has(idOrPrefix)) return runs.get(idOrPrefix);
    const matches = [...runs.values()].filter((run) => run.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const cancel = (idOrPrefix: string) => {
    const run = get(idOrPrefix);
    if (!run || run.status !== "running") return false;
    run.controller.abort();
    return true;
  };

  const waitForRun = async (idOrPrefix: string, timeoutMs = 30 * 60 * 1000) => {
    const run = get(idOrPrefix);
    if (!run) return undefined;
    if (run.status !== "running") return run;
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for background workflow ${run.id}.`)), timeoutMs);
      timer.unref?.();
    });
    await Promise.race([run.settled, timeout]);
    return run;
  };

  const waitForIdle = async (sessionId?: string, timeoutMs = 30 * 60 * 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const active = list().filter((run) => run.status === "running" && (!sessionId || run.sessionId === sessionId));
      if (active.length === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${active.length} background workflow(s) to finish.`);
      await Promise.race([
        Promise.allSettled(active.map((run) => run.settled)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("wait timeout")), Math.min(remaining, 1000))),
      ]).catch((error) => {
        if (error instanceof Error && error.message === "wait timeout") return;
        throw error;
      });
    }
  };

  const formatStatus = (idOrPrefix?: string) => {
    if (idOrPrefix?.trim()) {
      const run = get(idOrPrefix.trim());
      if (!run) return `No background workflow found for: ${idOrPrefix}`;
      return formatRunStatus(run, true);
    }
    const all = list();
    if (all.length === 0) return "No background workflows in this session.";
    return ["Background workflows:", ...all.map((run) => `- ${formatRunStatus(run, false)}`)].join("\n");
  };

  const formatResult = (idOrPrefix: string) => {
    const run = get(idOrPrefix.trim());
    if (!run) return `No background workflow found for: ${idOrPrefix}`;
    return formatRunResult(run);
  };

  return { start, list, listActiveWork, get, cancel, waitForRun, waitForIdle, formatStatus, formatResult };
}

export function formatRunStatus(run: BackgroundWorkflowRun, verbose: boolean): string {
  const base = `${run.id} [${run.status}] ${run.name} (${run.snapshot.doneCount}/${run.snapshot.agentCount} done)`;
  if (!verbose) return base;
  const lines = [
    base,
    `Description: ${run.description}`,
    `Started: ${run.startedAt}`,
    `Updated: ${run.updatedAt}`,
    `Artifacts: ${run.artifactDir}`,
    `Output: ${run.outputPath}`,
  ];
  if (run.completedAt) lines.push(`Completed: ${run.completedAt}`);
  if (run.error) lines.push(`Error: ${run.error}`);
  lines.push("", renderWorkflowText(run.snapshot, run.status !== "running"));
  return lines.join("\n");
}

export function formatRunResult(run: BackgroundWorkflowRun): string {
  const heading = `Background workflow ${run.status}: ${run.name}`;
  const lines = [heading, "", `Run ID: ${run.id}`, `Artifacts: ${run.artifactDir}`, ""];
  lines.push(renderWorkflowText(run.snapshot, run.status !== "running"));
  if (run.error) lines.push("", `Error: ${run.error}`);
  if (run.result) lines.push("", "Result:", "```json", JSON.stringify(run.result.result, null, 2), "```");
  return lines.join("\n");
}

function makeRunId(meta: WorkflowMeta, runsRoot: string, existingRuns?: Map<string, BackgroundWorkflowRun>): string {
  const name = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let id = `${stamp}-${name}`;
  let suffix = 2;
  while (existingRuns?.has(id) || existsSync(resolve(runsRoot, id))) id = `${stamp}-${name}-${suffix++}`;
  return id;
}
