import { execFile } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import {
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowMeta, type WorkflowRunResult } from "./workflow.js";

const execFileAsync = promisify(execFile);

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
  resumeChild(idOrPrefix: string, prompt: string, selector?: string | number): Promise<string>;
  steerChild(idOrPrefix: string, prompt: string, selector?: string | number): Promise<string>;
  listWorktrees(idOrPrefix?: string): Array<{ runId: string; agentId: number; label: string; path: string; exists: boolean }>;
  cleanupWorktrees(idOrPrefix?: string, force?: boolean): Promise<{ removed: string[]; failed: Array<{ path: string; error: string }> }>;
  formatStatus(idOrPrefix?: string): string;
  formatResult(idOrPrefix: string): string;
  formatTranscript(idOrPrefix: string, selector?: string | number, lines?: number): string;
  formatEvents(idOrPrefix: string, lines?: number): string;
  formatSummary(idOrPrefix: string): string;
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
  const liveSessions = new Map<string, { runId: string; label: string; sessionFile?: string; session: any }>();
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
          onAgentLiveSession(event) {
            liveSessions.set(liveKey(run.id, event.label), { runId: run.id, label: event.label, sessionFile: event.sessionFile, session: event.session });
            appendEventSync(run, { type: "workflow.agent.live", label: event.label, phase: event.phase, sessionFile: event.sessionFile });
          },
          onAgentLiveSessionEnd(event) {
            liveSessions.delete(liveKey(run.id, event.label));
            appendEventSync(run, { type: "workflow.agent.live_end", label: event.label, phase: event.phase, sessionFile: event.sessionFile });
          },
          onAgentToolBudget(event) {
            const agent = [...run.snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.toolBudget = {
                count: event.count,
                hard: event.hard,
                ...(event.soft !== undefined ? { soft: event.soft } : {}),
                ...(event.type === "soft" ? { softReached: true } : agent.toolBudget?.softReached ? { softReached: true } : {}),
                ...(event.type === "hard" ? { hardExceeded: true, tool: event.tool } : agent.toolBudget?.hardExceeded ? { hardExceeded: true, tool: agent.toolBudget.tool } : {}),
              };
            }
            appendEventSync(run, { type: "workflow.agent.tool_budget", label: event.label, phase: event.phase, budgetEvent: event.type, tool: event.tool, count: event.count, hard: event.hard, soft: event.soft });
            update(run);
          },
          onAgentAttempt(event) {
            const agent = [...run.snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.attempts ??= [];
              agent.attempts.push({ model: event.model, attempt: event.attempt, status: event.status, ...(event.error ? { error: event.error } : {}) });
            }
            appendEventSync(run, { type: "workflow.agent.attempt", label: event.label, phase: event.phase, model: event.model, attempt: event.attempt, status: event.status, error: event.error });
            update(run);
          },
          onAgentWorktree(event) {
            const agent = [...run.snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) agent.worktreePath = event.worktreePath;
            appendEventSync(run, { type: "workflow.agent.worktree", label: event.label, phase: event.phase, worktreePath: event.worktreePath });
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
            appendEventSync(run, { type: "workflow.agent.ended", label: event.label, phase: event.phase, status: event.result === null ? "error" : "done", resultPreview: preview(event.result), sessionFile: agent?.sessionFile, worktreePath: agent?.worktreePath });
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

  const liveKey = (runId: string, label: string) => `${runId}\0${label}`;

  const resumeChild = async (idOrPrefix: string, prompt: string, selector?: string | number) => {
    const run = get(idOrPrefix.trim());
    if (!run) throw new Error(`No background workflow found for: ${idOrPrefix}`);
    const agent = selectTranscriptAgent(run, selector);
    if (!agent?.sessionFile) throw new Error(`No persisted child session matched selector: ${selector ?? "(first)"}`);
    const runner = new WorkflowAgent({ cwd: run.cwd });
    const result = await runner.resume(prompt, agent.sessionFile, { label: `resume ${agent.label}` });
    appendEventSync(run, { type: "workflow.agent.resumed", label: agent.label, sessionFile: agent.sessionFile, prompt, resultPreview: preview(result) });
    return result;
  };

  const steerChild = async (idOrPrefix: string, prompt: string, selector?: string | number) => {
    const run = get(idOrPrefix.trim());
    if (!run) throw new Error(`No background workflow found for: ${idOrPrefix}`);
    const agent = selectTranscriptAgent(run, selector) ?? run.snapshot.agents[0];
    if (!agent) throw new Error(`No child agent matched selector: ${selector ?? "(first)"}`);
    const live = liveSessions.get(liveKey(run.id, agent.label));
    if (!live) throw new Error(`Child agent is not currently live/running: ${agent.label}`);
    if (typeof live.session.steer === "function") await live.session.steer(prompt);
    else if (typeof live.session.sendUserMessage === "function") await live.session.sendUserMessage(prompt, { deliverAs: "steer" });
    else throw new Error("Live child session does not support steering.");
    appendEventSync(run, { type: "workflow.agent.steered", label: agent.label, sessionFile: live.sessionFile, prompt });
    return `Steered live child ${agent.label} for workflow ${run.id}.`;
  };

  const listWorktrees = (idOrPrefix?: string) => {
    const sourceRuns = idOrPrefix?.trim() ? (get(idOrPrefix.trim()) ? [get(idOrPrefix.trim())!] : []) : list();
    return sourceRuns.flatMap((run) => run.snapshot.agents
      .filter((agent) => agent.worktreePath)
      .map((agent) => ({
        runId: run.id,
        agentId: agent.id,
        label: agent.label,
        path: agent.worktreePath!,
        exists: existsSync(agent.worktreePath!),
      })));
  };

  const cleanupWorktrees = async (idOrPrefix?: string, force = false) => {
    const removed: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const item of listWorktrees(idOrPrefix)) {
      if (!item.exists) continue;
      if (!force) {
        try {
          const { stdout } = await execFileAsync("git", ["-C", item.path, "status", "--porcelain"]);
          if (stdout.trim()) {
            failed.push({ path: item.path, error: "Worktree has uncommitted changes; pass force:true to remove it." });
            continue;
          }
        } catch (error) {
          failed.push({ path: item.path, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", item.path]);
      } catch (error) {
        if (!force) {
          failed.push({ path: item.path, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        try {
          await rm(item.path, { recursive: true, force: true });
        } catch (rmError) {
          failed.push({ path: item.path, error: rmError instanceof Error ? rmError.message : String(rmError) });
          continue;
        }
      }
      removed.push(item.path);
    }
    return { removed, failed };
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

  const formatTranscript = (idOrPrefix: string, selector?: string | number, lines?: number) => {
    const run = get(idOrPrefix.trim());
    if (!run) return `No background workflow found for: ${idOrPrefix}`;
    return formatRunTranscript(run, selector, lines);
  };

  const formatEvents = (idOrPrefix: string, lines?: number) => {
    const run = get(idOrPrefix.trim());
    if (!run) return `No background workflow found for: ${idOrPrefix}`;
    return formatRunEvents(run, lines);
  };

  const formatSummary = (idOrPrefix: string) => {
    const run = get(idOrPrefix.trim());
    if (!run) return `No background workflow found for: ${idOrPrefix}`;
    return formatRunSummary(run);
  };

  return { start, list, listActiveWork, get, cancel, waitForRun, waitForIdle, resumeChild, steerChild, listWorktrees, cleanupWorktrees, formatStatus, formatResult, formatTranscript, formatEvents, formatSummary };
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

function selectTranscriptAgent(run: BackgroundWorkflowRun, selector?: string | number) {
  const agents = run.snapshot.agents.filter((agent) => agent.sessionFile);
  if (agents.length === 0) return undefined;
  let agent = agents[0];
  if (selector !== undefined) {
    if (typeof selector === "number" || /^\d+$/.test(String(selector))) {
      const index = Number(selector);
      agent = agents[index - 1] ?? agents[index] ?? agent;
    } else {
      const text = String(selector).toLowerCase();
      agent = agents.find((candidate) => candidate.label.toLowerCase().includes(text)) ?? agent;
    }
  }
  return agent;
}

export function formatRunSummary(run: BackgroundWorkflowRun): string {
  const failedAgents = run.snapshot.agents.filter((agent) => agent.status === "error");
  const skippedAgents = run.snapshot.agents.filter((agent) => agent.status === "skipped");
  const sessionAgents = run.snapshot.agents.filter((agent) => agent.sessionFile);
  const worktreeAgents = run.snapshot.agents.filter((agent) => agent.worktreePath);
  const attemptAgents = run.snapshot.agents.filter((agent) => agent.attempts?.length);
  const budgetAgents = run.snapshot.agents.filter((agent) => agent.toolBudget);
  const nextActions: string[] = [];
  if (run.status === "running") nextActions.push(`Use workflow_wait with id ${run.id} to wait for completion, or workflow_cancel to stop it.`);
  if (run.status === "failed") nextActions.push(`Use workflow_events ${run.id} and workflow_transcript ${run.id} to inspect the failure.`);
  if (sessionAgents.length > 0) nextActions.push(`Use workflow_transcript ${run.id} to inspect child session transcripts.`);
  if (sessionAgents.length > 0 && run.status !== "running") nextActions.push(`Use workflow_resume ${run.id} with a follow-up prompt to continue a child session.`);
  if (worktreeAgents.length > 0) nextActions.push(`Use workflow_worktrees ${run.id} to inspect isolated worktrees; use workflow_worktree_cleanup when done.`);
  if (nextActions.length === 0) nextActions.push("No follow-up action is required unless the result needs further review.");

  return [
    `Workflow summary: ${run.id}`,
    `Name: ${run.name}`,
    `Status: ${run.status}`,
    `Description: ${run.description}`,
    `Started: ${run.startedAt}`,
    `Updated: ${run.updatedAt}`,
    ...(run.completedAt ? [`Completed: ${run.completedAt}`] : []),
    `Artifacts: ${run.artifactDir}`,
    `Output: ${run.outputPath}`,
    `Events: ${run.eventsPath}`,
    `Result: ${run.resultPath}`,
    "",
    `Agents: ${run.snapshot.doneCount}/${run.snapshot.agentCount} done, ${run.snapshot.runningCount} running, ${run.snapshot.errorCount} errors`,
    ...(failedAgents.length ? [`Failed agents: ${failedAgents.map((agent) => `#${agent.id} ${agent.label}`).join(", ")}`] : []),
    ...(skippedAgents.length ? [`Skipped agents: ${skippedAgents.map((agent) => `#${agent.id} ${agent.label}`).join(", ")}`] : []),
    ...(sessionAgents.length ? [`Child sessions: ${sessionAgents.map((agent) => `#${agent.id} ${agent.label} -> ${agent.sessionFile}`).join("; ")}`] : []),
    ...(worktreeAgents.length ? [`Worktrees: ${worktreeAgents.map((agent) => `#${agent.id} ${agent.label} -> ${agent.worktreePath}`).join("; ")}`] : []),
    ...(attemptAgents.length ? [`Model attempts: ${attemptAgents.map((agent) => `#${agent.id} ${agent.label}: ${agent.attempts?.map((attempt) => `${attempt.model ?? "default"}:${attempt.status}`).join(" -> ")}`).join("; ")}`] : []),
    ...(budgetAgents.length ? [`Tool budgets: ${budgetAgents.map((agent) => `#${agent.id} ${agent.label}: ${agent.toolBudget?.count}/${agent.toolBudget?.hard}${agent.toolBudget?.softReached ? " soft" : ""}${agent.toolBudget?.hardExceeded ? ` hard(${agent.toolBudget.tool})` : ""}`).join("; ")}`] : []),
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(run.result ? ["", "Result preview:", JSON.stringify(run.result.result, null, 2).slice(0, 4000)] : []),
    "",
    "Suggested next actions:",
    ...nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

export function formatRunEvents(run: BackgroundWorkflowRun, lines = 120): string {
  if (!existsSync(run.eventsPath)) return `Workflow ${run.id} has no events file: ${run.eventsPath}`;
  const parsed = readFileSync(run.eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return { type: "malformed", raw: line }; }
    });
  const limit = Math.max(1, Math.min(lines, 1000));
  const tail = parsed.slice(-limit);
  return [
    `Workflow events: ${run.id}`,
    `Events file: ${run.eventsPath}`,
    `Showing ${tail.length}/${parsed.length} event${parsed.length === 1 ? "" : "s"}`,
    "",
    ...tail.map(formatWorkflowEventLine),
  ].join("\n");
}

function formatWorkflowEventLine(event: any): string {
  const ts = event.ts ? `${event.ts} ` : "";
  const type = event.type ?? "unknown";
  const rest = { ...event };
  delete rest.ts;
  delete rest.type;
  return `${ts}${type} ${JSON.stringify(rest)}`.trim();
}

export function formatRunTranscript(run: BackgroundWorkflowRun, selector?: string | number, lines = 80): string {
  if (!run.snapshot.agents.some((agent) => agent.sessionFile)) return `Workflow ${run.id} has no persisted child session transcripts.`;
  const agent = selectTranscriptAgent(run, selector);
  if (!agent?.sessionFile) return `No child agent transcript matched selector: ${selector ?? "(first)"}`;
  if (!existsSync(agent.sessionFile)) return `Child transcript file is missing: ${agent.sessionFile}`;
  const entries = readFileSync(agent.sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return undefined; }
    })
    .filter(Boolean);
  const rendered = entries.map(formatSessionEntryLine).filter(Boolean) as string[];
  const limit = Math.max(1, Math.min(lines, 500));
  const tail = rendered.slice(-limit);
  return [
    `Workflow transcript: ${run.id}`,
    `Agent: #${agent.id} ${agent.label}`,
    `Session file: ${agent.sessionFile}`,
    `Showing ${tail.length}/${rendered.length} rendered entr${rendered.length === 1 ? "y" : "ies"}`,
    "",
    ...tail,
  ].join("\n");
}

function formatSessionEntryLine(entry: any): string | undefined {
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  const role = message?.role ?? "unknown";
  if (role === "toolResult") {
    return `[toolResult:${message.toolName ?? "tool"}] ${textFromContent(message.content)}`;
  }
  if (role === "assistant" && message?.errorMessage) {
    return `[assistant:error] ${message.errorMessage}`;
  }
  return `[${role}] ${textFromContent(message?.content)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return shortenLine(content);
  if (!Array.isArray(content)) return "";
  return shortenLine(content.map((part) => {
    if (part?.type === "text") return part.text;
    if (part?.type === "toolCall") return `<tool:${part.name}> ${JSON.stringify(part.arguments ?? {})}`;
    if (part?.type === "thinking") return "<thinking>";
    if (part?.type === "image") return "<image>";
    return "";
  }).filter(Boolean).join(" "));
}

function shortenLine(text: string, max = 1000): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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
