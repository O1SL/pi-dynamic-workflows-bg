import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";
export type WorkflowGraphNodeStatus = "pending" | "running" | "done" | "error" | "skipped";
export type WorkflowGraphNodeKind = "agent" | "parallel" | "pipeline";
export type WorkflowGraphEdgeKind = "seq";

export interface WorkflowGraphUsage {
  tokens?: number;
  toolCount?: number;
  durationMs?: number;
  model?: string;
}

export interface WorkflowGraphNode {
  id: string;
  label: string;
  status: WorkflowGraphNodeStatus;
  kind: WorkflowGraphNodeKind;
  phase?: string;
  parentId?: string;
  pipelineCell?: { itemIndex: number; stageIndex: number; itemLabel?: string };
  usage?: WorkflowGraphUsage;
  artifactPath?: string;
  sessionFile?: string;
  worktreePath?: string;
  attempts?: Array<{ model?: string; attempt?: number; status: "failed" | "succeeded"; error?: string }>;
}

export interface WorkflowGraphEdge {
  from: string;
  to: string;
  kind: WorkflowGraphEdgeKind;
  label?: string;
}

export interface WorkflowGraph {
  runId: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  sessionFile?: string;
  worktreePath?: string;
  attempts?: Array<{ model?: string; attempt?: number; status: "failed" | "succeeded"; error?: string }>;
  toolBudget?: { count: number; softReached?: boolean; hardExceeded?: boolean; tool?: string; hard?: number; soft?: number };
  graphParentId?: string;
  pipelineCell?: { itemIndex: number; stageIndex: number; itemLabel?: string };
  startedAtMs?: number;
  durationMs?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  graph?: WorkflowGraph;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta, runId = meta.name): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    graph: { runId, nodes: [], edges: [] },
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount, graph: recomputeGraph(snapshot.graph) };
}

export function ensureWorkflowGraph(snapshot: WorkflowSnapshot, runId = snapshot.name): WorkflowGraph {
  snapshot.graph ??= { runId, nodes: [], edges: [] };
  return snapshot.graph;
}

export function upsertWorkflowGraphNode(snapshot: WorkflowSnapshot, node: WorkflowGraphNode): WorkflowGraphNode {
  const graph = ensureWorkflowGraph(snapshot);
  const existing = graph.nodes.find((candidate) => candidate.id === node.id);
  if (existing) {
    Object.assign(existing, pruneUndefined(node));
    return existing;
  }
  graph.nodes.push(pruneUndefined(node) as WorkflowGraphNode);
  graph.edges = recomputeGraph(graph)!.edges;
  return node;
}

export function updateWorkflowGraphNode(snapshot: WorkflowSnapshot, id: string, patch: Partial<WorkflowGraphNode>): WorkflowGraphNode | undefined {
  const graph = ensureWorkflowGraph(snapshot);
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return undefined;
  Object.assign(node, pruneUndefined(patch));
  graph.edges = recomputeGraph(graph)!.edges;
  return node;
}

export function agentStatusToGraphStatus(status: WorkflowAgentStatus): WorkflowGraphNodeStatus {
  if (status === "queued") return "pending";
  return status;
}

function recomputeGraph(graph: WorkflowGraph | undefined): WorkflowGraph | undefined {
  if (!graph) return undefined;
  const topLevel = graph.nodes.filter((node) => !node.parentId);
  const edges: WorkflowGraphEdge[] = [];
  for (let i = 1; i < topLevel.length; i++) edges.push({ from: topLevel[i - 1]!.id, to: topLevel[i]!.id, kind: "seq" });
  return { ...graph, edges };
}

function pruneUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }
  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
