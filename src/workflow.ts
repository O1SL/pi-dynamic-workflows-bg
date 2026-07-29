import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import { WorkflowAgent, type AgentToolBudget, type AgentTurnBudget, type WorkflowAgentOptions } from "./agent.js";
import type { ToolBudgetEvent } from "./tool-budget.js";

const execFileAsync = promisify(execFile);

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowContinuationParent {
  runId: string;
  name: string;
  description: string;
  status: string;
  artifactDir: string;
  statusPath: string;
  outputPath: string;
  resultPath: string;
  eventsPath: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  snapshot: {
    phases: string[];
    currentPhase?: string;
    agents: Array<{
      id: number;
      agentRunId?: string;
      label: string;
      phase?: string;
      status: string;
      resultPreview?: string;
      error?: string;
      durationMs?: number;
      attempts?: Array<{ model?: string; attempt?: number; status: "failed" | "succeeded"; error?: string }>;
    }>;
  };
  result?: unknown;
  resultTruncated?: boolean;
}

export interface WorkflowContinuationContext {
  version: 1;
  kind: "extend" | "replace_tail";
  createdAt: string;
  parent: WorkflowContinuationParent;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  /** Read-only context supplied only to linked follow-up workflows. */
  continuation?: WorkflowContinuationContext;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { agentRunId: string; label: string; phase?: string; prompt: string; parentId?: string; pipelineCell?: { itemIndex: number; stageIndex: number; itemLabel?: string } }) => void;
  onAgentEnd?: (event: { agentRunId: string; label: string; phase?: string; result: unknown; error?: string }) => void;
  onAgentSession?: (event: { agentRunId: string; label: string; phase?: string; sessionFile?: string }) => void;
  onAgentWorktree?: (event: { agentRunId: string; label: string; phase?: string; worktreePath: string }) => void;
  onAgentAttempt?: (event: { agentRunId: string; label: string; phase?: string; model?: string; attempt: number; status: "failed" | "succeeded"; error?: string }) => void;
  onAgentToolBudget?: (event: { agentRunId: string; label: string; phase?: string } & ToolBudgetEvent) => void;
  onAgentLiveSession?: (event: { agentRunId: string; label: string; phase?: string; session: any; sessionFile?: string }) => void;
  onAgentLiveSessionEnd?: (event: { agentRunId: string; label: string; phase?: string; sessionFile?: string }) => void;
  onGraphGroupStart?: (event: { id: string; label: string; kind: "parallel" | "pipeline"; phase?: string; parentId?: string; pipelineCell?: { itemIndex: number; stageIndex: number; itemLabel?: string } }) => void;
  onGraphGroupEnd?: (event: { id: string; status: "done" | "error" | "skipped" }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  fallbackModels?: string[];
  isolation?: "worktree";
  agentType?: string;
  timeoutMs?: number;
  toolBudget?: AgentToolBudget;
  turnBudget?: AgentTurnBudget;
  retry?: number;
  retryDelayMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  agentRunCount: number;
  graphGroupCount: number;
  spent: number;
}

interface GraphRuntimeContext {
  parentId?: string;
  pipelineCell?: { itemIndex: number; stageIndex: number; itemLabel?: string };
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, agentRunCount: 0, graphGroupCount: 0, spent: 0 };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();
  const graphContext = new AsyncLocalStorage<GraphRuntimeContext>();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
    const requestedLabel = normalizedOptions.label?.trim();
    const run = limiter(async () => {
      state.agentCount++;
      state.agentRunCount++;
      const agentRunId = `a${state.agentRunCount}`;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      const context = graphContext.getStore();
      options.onAgentStart?.({ agentRunId, label, phase: assignedPhase, prompt: taskPrompt, parentId: context?.parentId, pipelineCell: context?.pipelineCell });
      try {
        throwIfAborted();
        const childSignal = createChildSignal(options.signal, normalizedOptions.timeoutMs);
        const worktreePath = normalizedOptions.isolation === "worktree"
          ? await createWorkflowWorktree(options.cwd ?? process.cwd(), label)
          : undefined;
        if (worktreePath) options.onAgentWorktree?.({ agentRunId, label, phase: assignedPhase, worktreePath });
        const effectiveAgentRunner = worktreePath && !options.agent
          ? new WorkflowAgent({ ...options, cwd: worktreePath, sessionDir: options.sessionDir ? join(options.sessionDir, "worktrees", sanitizePathSegment(label)) : undefined })
          : agentRunner;
        const modelsToTry = [normalizedOptions.model, ...(normalizedOptions.fallbackModels ?? [])];
        const retry = normalizedOptions.retry ?? 1;
        const retryDelayMs = normalizedOptions.retryDelayMs ?? 1000;
        let lastError: unknown;
        let globalAttempt = 0;
        for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
          const model = modelsToTry[modelIndex];
          for (let retryAttempt = 0; retryAttempt <= retry; retryAttempt++) {
            globalAttempt++;
            try {
              const result = await effectiveAgentRunner.run(taskPrompt, {
              label,
              schema: normalizedOptions.schema,
              signal: childSignal,
              model,
              toolBudget: normalizedOptions.toolBudget,
              turnBudget: normalizedOptions.turnBudget,
              onToolBudgetEvent: (event: ToolBudgetEvent) => options.onAgentToolBudget?.({ agentRunId, label, phase: assignedPhase, ...event }),
              onLiveSession: (info: { session: any; sessionFile?: string }) => options.onAgentLiveSession?.({ agentRunId, label, phase: assignedPhase, session: info.session, sessionFile: info.sessionFile }),
              onLiveSessionEnd: (info: { sessionFile?: string }) => options.onAgentLiveSessionEnd?.({ agentRunId, label, phase: assignedPhase, sessionFile: info.sessionFile }),
              instructions: buildAgentInstructions(assignedPhase, { ...normalizedOptions, model }),
              onSession: (info: { sessionFile?: string }) => options.onAgentSession?.({ agentRunId, label, phase: assignedPhase, sessionFile: info.sessionFile }),
              } as any);
              lastError = undefined;
              options.onAgentAttempt?.({ agentRunId, label, phase: assignedPhase, model, attempt: globalAttempt, status: "succeeded" });
              if (modelIndex > 0) log(`agent ${label} succeeded with fallback model ${model}`);
              if (retryAttempt > 0) log(`agent ${label} succeeded after retry ${retryAttempt} with model ${model ?? "default"}`);
              throwIfAborted();
              state.spent += estimateTokens(result);
              options.onAgentEnd?.({ agentRunId, label, phase: assignedPhase, result });
              return result;
            } catch (error) {
              lastError = error;
              options.onAgentAttempt?.({ agentRunId, label, phase: assignedPhase, model, attempt: globalAttempt, status: "failed", error: error instanceof Error ? error.message : String(error) });
              if (options.signal?.aborted || childSignal?.aborted) throw error;
              if (!isRetryableModelError(error)) throw error;
              if (retryAttempt < retry) {
                log(`agent ${label} failed with model ${model ?? "default"}; retrying attempt ${retryAttempt + 1}/${retry}: ${error instanceof Error ? error.message : String(error)}`);
                await sleep(retryDelayMs);
                continue;
              }
              const hasFallback = modelIndex + 1 < modelsToTry.length;
              if (!hasFallback) throw error;
              log(`agent ${label} failed with model ${model ?? "default"}; retrying fallback ${modelsToTry[modelIndex + 1]}: ${error instanceof Error ? error.message : String(error)}`);
              break;
            }
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        options.onAgentEnd?.({ agentRunId, label, phase: assignedPhase, result: null, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    );
    return run;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const id = nextGraphGroupId(state);
    const phaseForGroup = state.currentPhase;
    const parentContext = graphContext.getStore();
    options.onGraphGroupStart?.({ id, label: `parallel ×${thunks.length}`, kind: "parallel", phase: phaseForGroup, parentId: parentContext?.parentId, pipelineCell: parentContext?.pipelineCell });
    let hadError = false;
    try {
      return await Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await graphContext.run({ parentId: id }, thunk);
          } catch (error) {
            if (options.signal?.aborted) throw error;
            hadError = true;
            log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }),
      );
    } finally {
      options.onGraphGroupEnd?.({ id, status: options.signal?.aborted ? "skipped" : hadError ? "error" : "done" });
    }
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const id = nextGraphGroupId(state);
    const phaseForGroup = state.currentPhase;
    const parentContext = graphContext.getStore();
    options.onGraphGroupStart?.({ id, label: `pipeline ${items.length}×${stages.length}`, kind: "pipeline", phase: phaseForGroup, parentId: parentContext?.parentId, pipelineCell: parentContext?.pipelineCell });
    let hadError = false;
    try {
      return await Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
            const stage = stages[stageIndex]!;
            try {
              throwIfAborted();
              value = await graphContext.run({ parentId: id, pipelineCell: { itemIndex: index, stageIndex, itemLabel: graphItemLabel(item, index) } }, () => stage(value, item, index));
              throwIfAborted();
            } catch (error) {
              if (options.signal?.aborted) throw error;
              hadError = true;
              log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          }
          return value;
        }),
      );
    } finally {
      options.onGraphGroupEnd?.({ id, status: options.signal?.aborted ? "skipped" : hadError ? "error" : "done" });
    }
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    continuation: options.continuation ? deepFreeze(structuredClone(options.continuation)) : undefined,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math: safeMath(),
    Date: undefined,
    Function: undefined,
    eval: undefined,
    globalThis: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  }, { codeGeneration: { strings: false, wasm: false } });

  const wrapped = `(async function () {\n"use strict";\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
  await Promise.allSettled([...pendingAgentRuns]);
  assertJsonSerializable(result, "workflow result");
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }

  for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function safeMath(): Math {
  const clone = Object.create(null) as Math;
  for (const key of Object.getOwnPropertyNames(Math) as Array<keyof Math>) {
    if (key === "random") continue;
    Object.defineProperty(clone, key, Object.getOwnPropertyDescriptor(Math, key)!);
  }
  return Object.freeze(clone);
}

function nextGraphGroupId(state: RuntimeState): string {
  state.graphGroupCount++;
  return `g${state.graphGroupCount}`;
}

function graphItemLabel(item: unknown, index: number): string | undefined {
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return String(item);
  if (item && typeof item === "object") {
    const raw = item as Record<string, unknown>;
    const candidate = raw.name ?? raw.label ?? raw.id;
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return `item ${index + 1}`;
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    ...options,
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation,
    agentType: optionalString(options.agentType, "agent type"),
    timeoutMs: optionalPositiveNumber(options.timeoutMs, "agent timeoutMs"),
    fallbackModels: optionalStringArray((options as AgentOptions & { fallbackModels?: unknown }).fallbackModels, "agent fallbackModels"),
    toolBudget: optionalToolBudget((options as AgentOptions & { toolBudget?: unknown }).toolBudget),
    turnBudget: optionalTurnBudget((options as AgentOptions & { turnBudget?: unknown }).turnBudget),
    retry: optionalNonNegativeInteger((options as AgentOptions & { retry?: unknown }).retry, "agent retry") ?? 1,
    retryDelayMs: optionalPositiveNumber((options as AgentOptions & { retryDelayMs?: unknown }).retryDelayMs, "agent retryDelayMs") ?? 1000,
  };
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function optionalTurnBudget(value: unknown): AgentTurnBudget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("agent turnBudget must be an object");
  const raw = value as Record<string, unknown>;
  const maxTurns = optionalPositiveNumber(raw.maxTurns, "agent turnBudget.maxTurns");
  if (maxTurns === undefined) throw new TypeError("agent turnBudget.maxTurns is required");
  const graceTurns = optionalPositiveNumber(raw.graceTurns, "agent turnBudget.graceTurns");
  return { maxTurns, ...(graceTurns !== undefined ? { graceTurns } : {}) };
}

function optionalToolBudget(value: unknown): AgentToolBudget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("agent toolBudget must be an object");
  const raw = value as Record<string, unknown>;
  const hard = optionalPositiveNumber(raw.hard, "agent toolBudget.hard");
  if (hard === undefined) throw new TypeError("agent toolBudget.hard is required");
  const soft = optionalPositiveNumber(raw.soft, "agent toolBudget.soft");
  const block = raw.block === undefined ? undefined : raw.block === "*" ? "*" : optionalStringArray(raw.block, "agent toolBudget.block");
  return { hard, ...(soft !== undefined ? { soft } : {}), ...(block !== undefined ? { block } : {}) };
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return [...value];
}

function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

async function createWorkflowWorktree(cwd: string, label: string): Promise<string> {
  await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = join(cwd, ".pi-workflows", "worktrees");
  await mkdir(root, { recursive: true });
  const path = join(root, `${Date.now()}-${sanitizePathSegment(label)}`);
  await execFileAsync("git", ["-C", cwd, "worktree", "add", "--detach", path, "HEAD"]);
  return path;
}

function sanitizePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
}

function createChildSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!parent && timeoutMs === undefined) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  if (timeoutMs !== undefined) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
  }
  return controller.signal;
}

function assertJsonSerializable(value: unknown, name: string, path = name, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers`);
  }
  if (typeof value === "undefined") throw new Error(`${path} must not be undefined; return null instead`);
  if (typeof value === "bigint") throw new Error(`${path} must not contain BigInt; convert it to string or number`);
  if (typeof value === "function" || typeof value === "symbol") throw new Error(`${path} must be JSON serializable`);
  if (typeof value !== "object") throw new Error(`${path} must be JSON serializable`);
  if (seen.has(value)) throw new Error(`${path} must not contain circular references`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSerializable(item, name, `${path}[${index}]`, seen));
  } else {
    if (Object.prototype.toString.call(value) !== "[object Object]") {
      const prototype = Object.getPrototypeOf(value);
      throw new Error(`${path} must use plain JSON objects; ${prototype?.constructor?.name ?? "custom"} is not supported`);
    }
    for (const [key, item] of Object.entries(value)) assertJsonSerializable(item, name, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  if (options.model) lines.push(`Requested model: ${options.model}`);
  if (options.timeoutMs) lines.push(`Requested timeoutMs: ${options.timeoutMs}`);
  if (options.fallbackModels?.length) lines.push(`Fallback models: ${options.fallbackModels.join(", ")}`);
  if (options.toolBudget) lines.push(`Tool budget hard limit: ${options.toolBudget.hard}`);
  if (options.turnBudget) lines.push(`Turn budget: ${options.turnBudget.maxTurns} + ${options.turnBudget.graceTurns ?? 0} grace`);
  if (options.retry !== undefined) lines.push(`Retry budget: ${options.retry}`);
  return lines.length ? lines.join("\n") : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|quota|rate.?limit|resource|capacity|overloaded|timeout|timed out|unavailable|provider|model|auth|api key|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/i.test(message);
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
