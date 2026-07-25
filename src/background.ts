import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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

export type BackgroundWorkflowStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface BackgroundWorkflowRun {
  id: string;
  name: string;
  description: string;
  status: BackgroundWorkflowStatus;
  cwd: string;
  sessionId?: string;
  ownerPid?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  artifactDir: string;
  outputPath: string;
  resultPath: string;
  statusPath: string;
  eventsPath: string;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: string;
  notified?: boolean;
  restored?: boolean;
  controller: AbortController;
  settled: Promise<void>;
}

export interface BackgroundWorkflowStartOptions extends WorkflowAgentOptions {
  script: string;
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  tokenBudget?: number | null;
  session?: Partial<CreateAgentSessionOptions>;
  sessionId?: string;
}

export interface BackgroundWorkflowManagerOptions {
  runsRoot?: string;
  restore?: boolean;
  maxNotificationChars?: number;
  notificationBatchMs?: number;
  notify?: (message: string, run: BackgroundWorkflowRun) => void | Promise<void>;
  notifyBatch?: (message: string, runs: BackgroundWorkflowRun[]) => void | Promise<void>;
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

const DEFAULT_MAX_NOTIFICATION_CHARS = 24_000;

type WorkflowEvent = Record<string, unknown> & { type: string; ts: string };

export function createBackgroundWorkflowManager(
  options: BackgroundWorkflowManagerOptions = {},
): BackgroundWorkflowManager {
  const runs = new Map<string, BackgroundWorkflowRun>();
  const runsRoot = options.runsRoot ?? defaultRunsRoot();
  const maxNotificationChars = options.maxNotificationChars ?? DEFAULT_MAX_NOTIFICATION_CHARS;
  const notificationBatchMs = Math.max(0, options.notificationBatchMs ?? 300);
  const notifiedIds = new Set<string>();
  const settledResolvers = new Map<string, () => void>();
  let notificationBatch: BackgroundWorkflowRun[] = [];
  let notificationBatchTimer: NodeJS.Timeout | undefined;

  const eventLine = (event: Omit<WorkflowEvent, "ts">) => `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`;

  const resolveRunSettled = (run: BackgroundWorkflowRun) => {
    const resolveSettled = settledResolvers.get(run.id);
    settledResolvers.delete(run.id);
    resolveSettled?.();
  };

  const appendEvent = async (run: BackgroundWorkflowRun, event: Omit<WorkflowEvent, "ts">) => {
    await mkdir(run.artifactDir, { recursive: true });
    await appendFile(run.eventsPath, eventLine(event), "utf8");
  };

  const appendEventSync = (run: BackgroundWorkflowRun, event: Omit<WorkflowEvent, "ts">) => {
    mkdirSync(run.artifactDir, { recursive: true });
    appendFileSync(run.eventsPath, eventLine(event), "utf8");
  };

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

  const flushNotificationBatch = async () => {
    const batch = notificationBatch;
    notificationBatch = [];
    if (notificationBatchTimer) clearTimeout(notificationBatchTimer);
    notificationBatchTimer = undefined;
    if (batch.length === 0) return;
    const pending = batch.filter((run) => !notifiedIds.has(run.id));
    if (pending.length === 0) return;
    for (const run of pending) {
      notifiedIds.add(run.id);
      run.notified = true;
    }
    try {
      if (pending.length === 1) {
        await options.notify?.(formatNotification(pending[0]!, maxNotificationChars), pending[0]!);
      } else if (options.notifyBatch) {
        await options.notifyBatch(formatNotificationBatch(pending, maxNotificationChars), pending);
      } else {
        await options.notify?.(formatNotificationBatch(pending, maxNotificationChars), pending[0]!);
      }
    } finally {
      await Promise.allSettled(pending.map((run) => persist(run)));
      for (const run of pending) resolveRunSettled(run);
    }
  };

  const queueNotification = (run: BackgroundWorkflowRun) => {
    if (notifiedIds.has(run.id) || run.notified) {
      resolveRunSettled(run);
      return;
    }
    notificationBatch.push(run);
    if (notificationBatchMs === 0 || run.status !== "completed") {
      void flushNotificationBatch().catch(() => {
        for (const queued of notificationBatch.splice(0)) resolveRunSettled(queued);
      });
      return;
    }
    if (!notificationBatchTimer) {
      notificationBatchTimer = setTimeout(() => {
        void flushNotificationBatch().catch(() => {
          for (const queued of notificationBatch.splice(0)) resolveRunSettled(queued);
        });
      }, notificationBatchMs);
    }
  };

  const update = (run: BackgroundWorkflowRun) => {
    run.updatedAt = new Date().toISOString();
    run.snapshot = recomputeWorkflowSnapshot(run.snapshot);
    void persist(run).catch(() => undefined);
  };

  const restoreRuns = () => {
    if (options.restore === false || !existsSync(runsRoot)) return;
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statusPath = join(runsRoot, entry.name, "status.json");
      if (!existsSync(statusPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(statusPath, "utf8")) as Partial<BackgroundWorkflowRun>;
        if (!raw.id || !raw.name || !raw.status || !raw.artifactDir || !raw.statusPath) continue;
        let resolveSettled!: () => void;
        const settled = new Promise<void>((resolve) => {
          resolveSettled = resolve;
        });
        if (raw.status === "running" && raw.ownerPid === process.pid) continue;
        const status: BackgroundWorkflowStatus = raw.status === "running" ? "interrupted" : raw.status;
        const restored: BackgroundWorkflowRun = {
          id: raw.id,
          name: raw.name,
          description: raw.description ?? raw.name,
          status,
          cwd: raw.cwd ?? process.cwd(),
          ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
          ...(raw.ownerPid ? { ownerPid: raw.ownerPid } : {}),
          startedAt: raw.startedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(raw.completedAt ? { completedAt: raw.completedAt } : status === "interrupted" ? { completedAt: new Date().toISOString() } : {}),
          artifactDir: raw.artifactDir,
          outputPath: raw.outputPath ?? join(raw.artifactDir, "output.md"),
          resultPath: raw.resultPath ?? join(raw.artifactDir, "result.json"),
          statusPath: raw.statusPath,
          eventsPath: raw.eventsPath ?? join(raw.artifactDir, "events.jsonl"),
          snapshot: raw.snapshot ?? createWorkflowSnapshot({ name: raw.name, description: raw.description ?? raw.name }),
          ...(raw.result ? { result: raw.result as WorkflowRunResult } : {}),
          ...(raw.error ? { error: raw.error } : status === "interrupted" ? { error: "Workflow was interrupted by process shutdown or reload." } : {}),
          notified: raw.notified ?? true,
          restored: true,
          controller: new AbortController(),
          settled,
        };
        resolveSettled();
        runs.set(restored.id, restored);
        if (restored.notified) notifiedIds.add(restored.id);
        if (raw.status === "running") {
          appendEventSync(restored, { type: "workflow.interrupted", id: restored.id });
          void persist(restored).catch(() => undefined);
        }
      } catch {
        // Ignore malformed historical run records.
      }
    }
  };

  restoreRuns();

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
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactDir,
      outputPath: join(artifactDir, "output.md"),
      resultPath: join(artifactDir, "result.json"),
      statusPath: join(artifactDir, "status.json"),
      eventsPath: join(artifactDir, "events.jsonl"),
      snapshot: createWorkflowSnapshot(parsed.meta),
      controller: new AbortController(),
      settled,
    };
    runs.set(id, run);
    settledResolvers.set(id, resolveSettled);
    await persist(run);
    appendEventSync(run, { type: "workflow.started", id: run.id, name: run.name, cwd: run.cwd });

    void (async () => {
      try {
        const result = await runWorkflow(script, {
          cwd: run.cwd,
          sessionDir: join(run.artifactDir, "sessions"),
          args: startOptions.args,
          concurrency: startOptions.concurrency,
          tokenBudget: startOptions.tokenBudget,
          signal: run.controller.signal,
          agent: startOptions.agent,
          session: startOptions.session,
          onLog(message) {
            run.snapshot.logs.push(message);
            appendEventSync(run, { type: "workflow.log", message });
            update(run);
          },
          onPhase(title) {
            run.snapshot.currentPhase = title;
            if (!run.snapshot.phases.includes(title)) run.snapshot.phases.push(title);
            appendEventSync(run, { type: "workflow.phase", title });
            update(run);
          },
          onAgentStart(event) {
            if (!run.snapshot.phases.includes(event.phase ?? "") && event.phase) run.snapshot.phases.push(event.phase);
            appendEventSync(run, { type: "workflow.agent.started", label: event.label, phase: event.phase, prompt: event.prompt });
            run.snapshot.agents.push({
              id: run.snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update(run);
          },
          onAgentSession(event) {
            const agent = [...run.snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent && event.sessionFile) agent.sessionFile = event.sessionFile;
            appendEventSync(run, { type: "workflow.agent.session", label: event.label, phase: event.phase, sessionFile: event.sessionFile });
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
            appendEventSync(run, { type: "workflow.agent.ended", label: event.label, phase: event.phase, status: event.result === null ? "error" : "done", resultPreview: preview(event.result), sessionFile: agent?.sessionFile });
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
        appendEventSync(run, { type: "workflow.completed", id: run.id });
      } catch (error) {
        run.status = run.controller.signal.aborted ? "cancelled" : "failed";
        run.error = error instanceof Error ? error.message : String(error);
        appendEventSync(run, { type: run.status === "cancelled" ? "workflow.cancelled" : "workflow.failed", id: run.id, error: run.error });
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
        queueNotification(run);
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
    if (run.status !== "running") {
      if (!run.notified && settledResolvers.has(run.id)) await run.settled;
      return run;
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for background workflow ${run.id}.`)), timeoutMs);
    });
    await Promise.race([run.settled, timeout]);
    return run;
  };

  const waitForIdle = async (sessionId?: string, timeoutMs = 30 * 60 * 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const active = list().filter((run) => run.status === "running" && (!sessionId || run.sessionId === sessionId));
      if (active.length === 0) {
        await flushNotificationBatch();
        return;
      }
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

export function formatNotification(run: BackgroundWorkflowRun, maxChars = DEFAULT_MAX_NOTIFICATION_CHARS): string {
  const full = formatRunResult(run);
  if (full.length <= maxChars) return full;
  const omitted = full.length - maxChars;
  return [
    `Background workflow ${run.status}: ${run.name}`,
    "",
    `Run ID: ${run.id}`,
    `Artifacts: ${run.artifactDir}`,
    `Output: ${run.outputPath}`,
    `Result: ${run.resultPath}`,
    "",
    renderWorkflowText(run.snapshot, run.status !== "running", { maxAgents: 12, maxLogs: 3 }),
    "",
    `Notification truncated by ${omitted} characters. Read the full result from output.md or call workflow_result with id ${run.id}.`,
  ].join("\n");
}

export function formatNotificationBatch(runs: BackgroundWorkflowRun[], maxChars = DEFAULT_MAX_NOTIFICATION_CHARS): string {
  const header = `Background workflows completed (${runs.length}): ${runs.map((run) => run.name).join(", ")}`;
  const blocks = [header, ""];
  for (const run of runs) {
    const oneLine = `${run.id} [${run.status}] ${run.name} (${run.snapshot.doneCount}/${run.snapshot.agentCount} done)`;
    blocks.push(`- ${oneLine}`);
    if (run.error) blocks.push(`  Error: ${run.error}`);
    if (run.result) blocks.push(`  Result: ${JSON.stringify(run.result.result)}`);
    blocks.push(`  Output: ${run.outputPath}`);
  }
  const full = blocks.join("\n");
  if (full.length <= maxChars) return full;
  return [
    header,
    "",
    `Batch notification truncated. ${runs.length} workflow(s) completed.`,
    ...runs.map((run) => `- ${run.id} [${run.status}] ${run.name} · output: ${run.outputPath}`),
  ].join("\n");
}

function makeRunId(meta: WorkflowMeta, runsRoot: string, existingRuns?: Map<string, BackgroundWorkflowRun>): string {
  const name = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let id = `${stamp}-${name}`;
  let suffix = 2;
  while (existingRuns?.has(id) || existsSync(resolve(runsRoot, id))) id = `${stamp}-${name}-${suffix++}`;
  return id;
}
