import type { Api, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import { applyToolBudgetToTools, type AgentToolBudget, type ToolBudgetEvent } from "./tool-budget.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Persist child sessions under this directory. Defaults to in-memory child sessions. */
  sessionDir?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export type { AgentToolBudget } from "./tool-budget.js";

export interface AgentTurnBudget {
  maxTurns: number;
  graceTurns?: number;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  onSession?: (info: { sessionFile?: string; label?: string }) => void;
  onLiveSession?: (info: { session: any; sessionFile?: string; label?: string }) => void;
  onLiveSessionEnd?: (info: { sessionFile?: string; label?: string }) => void;
  model?: string;
  toolBudget?: AgentToolBudget;
  turnBudget?: AgentTurnBudget;
  onToolBudgetEvent?: (event: ToolBudgetEvent) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionDir?: string;
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionDir = options.sessionDir;
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = applyToolBudgetToTools([...this.baseTools, ...(options.tools ?? [])], options.toolBudget, undefined, options.onToolBudgetEvent);

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentDir = getAgentDir();
    const sessionManager = this.sessionDir
      ? SessionManager.create(this.cwd, this.sessionDir)
      : SessionManager.inMemory(this.cwd);
    const model = this.resolveModel(options.model);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager,
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      ...(model ? { model } : {}),
    });

    options.onSession?.({ sessionFile: sessionManager.getSessionFile(), label: options.label });
    options.onLiveSession?.({ session, sessionFile: sessionManager.getSessionFile(), label: options.label });

    let removeAbortListener: (() => void) | undefined;
    try {
      const assistantTurnsBefore = this.assistantTurnCount(session.messages);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      this.throwIfTurnBudgetExceeded(session.messages, assistantTurnsBefore, options.turnBudget);
      this.throwIfLastAssistantErrored(session.messages);

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      options.onLiveSessionEnd?.({ sessionFile: sessionManager.getSessionFile(), label: options.label });
      session.dispose();
    }
  }

  async resume(prompt: string, sessionFile: string, options: AgentRunOptions = {}): Promise<string> {
    const customTools: ToolDefinition[] = applyToolBudgetToTools([...this.baseTools, ...(options.tools ?? [])], options.toolBudget, undefined, options.onToolBudgetEvent);
    const agentDir = getAgentDir();
    const sessionManager = SessionManager.open(sessionFile, undefined, this.cwd);
    const model = this.resolveModel(options.model);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager,
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      ...(model ? { model } : {}),
    });
    options.onLiveSession?.({ session, sessionFile: sessionManager.getSessionFile(), label: options.label });
    let removeAbortListener: (() => void) | undefined;
    try {
      const assistantTurnsBefore = this.assistantTurnCount(session.messages);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      await session.prompt(this.buildPrompt(prompt, options, false));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      this.throwIfTurnBudgetExceeded(session.messages, assistantTurnsBefore, options.turnBudget);
      this.throwIfLastAssistantErrored(session.messages);
      return this.lastAssistantText(session.messages);
    } finally {
      removeAbortListener?.();
      options.onLiveSessionEnd?.({ sessionFile: sessionManager.getSessionFile(), label: options.label });
      session.dispose();
    }
  }

  private resolveModel(spec: string | undefined): Model<Api> | undefined {
    if (!spec) return undefined;
    const registry = this.sessionOptions.modelRegistry;
    if (!registry) throw new Error(`Cannot resolve workflow child model '${spec}': no modelRegistry available`);
    const [provider, ...rest] = spec.includes("/") ? spec.split("/") : [];
    if (provider && rest.length > 0) {
      const id = rest.join("/");
      const found = registry.find(provider, id);
      if (!found) throw new Error(`Workflow child model not found: ${spec}`);
      return found;
    }
    const matches = registry.getAvailable().filter((model) => model.id === spec || `${model.provider}/${model.id}` === spec);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Workflow child model '${spec}' is ambiguous; use provider/model id`);
    const allMatches = registry.getAll().filter((model) => model.id === spec || `${model.provider}/${model.id}` === spec);
    if (allMatches.length === 1) return allMatches[0];
    throw new Error(`Workflow child model not found: ${spec}`);
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (options.turnBudget) {
      parts.push(`Turn budget: complete within ${options.turnBudget.maxTurns} assistant turn(s)${options.turnBudget.graceTurns ? ` plus ${options.turnBudget.graceTurns} grace turn(s)` : ""}. If you cannot finish, report the blocker concisely.`);
    }

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private assistantTurnCount(messages: unknown[]): number {
    return messages.filter((message) => (message as Partial<AssistantMessage> | undefined)?.role === "assistant").length;
  }

  private throwIfTurnBudgetExceeded(messages: unknown[], assistantTurnsBefore: number, budget: AgentTurnBudget | undefined): void {
    if (!budget) return;
    const used = this.assistantTurnCount(messages) - assistantTurnsBefore;
    const allowed = budget.maxTurns + (budget.graceTurns ?? 0);
    if (used > allowed) throw new Error(`Subagent turn budget exceeded: used ${used}, allowed ${allowed}`);
  }

  private throwIfLastAssistantErrored(messages: unknown[]): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as (Partial<AssistantMessage> & { stopReason?: string; errorMessage?: string }) | undefined;
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "error" || message.errorMessage) {
        throw new Error(message.errorMessage || "Subagent assistant response ended with provider/tool error");
      }
      return;
    }
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
