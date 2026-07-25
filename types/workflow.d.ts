/**
 * Ambient globals available inside pi-dynamic-workflows workflow scripts.
 *
 * Add this to a JavaScript or TypeScript workflow file for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflows-bg/workflow" />
 */

export {};

declare global {
  /** Literal workflow metadata. Must be the first statement: `export const meta = { ... }`. */
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    /** Optional documentation for an expected outline. Live progress is driven by `phase(...)`. */
    phases?: WorkflowMetaPhase[];
  }

  interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
  }

  interface WorkflowAgentOptions<TSchema = JsonSchema> {
    /** Short label shown in progress/status/artifacts. */
    label?: string;
    /** Override the current runtime phase for this agent. */
    phase?: string;
    /** JSON Schema for structured output. When present, the returned value is typed as unknown unless you provide a generic. */
    schema?: TSchema;
    /** Requested child model, e.g. `provider/model-id`. */
    model?: string;
    /** Fallback models to try after retryable provider/model failures for the primary model. */
    fallbackModels?: string[];
    /** Same-model retries for retryable provider/model failures. Default: 1. */
    retry?: number;
    /** Delay between same-model retries in milliseconds. Default: 1000. */
    retryDelayMs?: number;
    /** Abort this child after the given milliseconds. */
    timeoutMs?: number;
    /** Requested isolation mode. `worktree` creates a detached git worktree for this child. */
    isolation?: "worktree";
    /** Requested subagent role/type. Currently passed as child instructions. */
    agentType?: string;
    /** Per-child tool-call budget. */
    toolBudget?: WorkflowAgentToolBudget;
    /** Per-child assistant turn budget. */
    turnBudget?: WorkflowAgentTurnBudget;
  }

  interface WorkflowAgentToolBudget {
    /** Soft threshold that appends a model-visible warning once reached. */
    soft?: number;
    /** Hard threshold after which configured tools are blocked. */
    hard: number;
    /** Tools to block after hard threshold. Defaults to `*`. */
    block?: "*" | string[];
  }

  interface WorkflowAgentTurnBudget {
    /** Maximum assistant turns expected from the child. */
    maxTurns: number;
    /** Additional assistant turns tolerated before post-run enforcement fails the child. */
    graceTurns?: number;
  }

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
  interface JsonObject {
    [key: string]: JsonValue;
  }

  interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: JsonValue[];
    const?: JsonValue;
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowBudget {
    total: number | null;
    spent(): number;
    remaining(): number;
  }

  /** Spawn a subagent. Returns final text unless a structured-output schema is used with an explicit generic. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T>;

  /** Run independent async tasks concurrently. Pass functions, not already-created promises. */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Run each item through sequential async stages while different items may run concurrently. */
  function pipeline<TItem, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<TResult[]>;

  /** Mark the current workflow phase for progress grouping. */
  function phase(title: string): void;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** Optional JSON args passed to the workflow tool. Narrow with a local type assertion when needed. */
  const args: unknown;

  /** Current working directory for the workflow/subagents. */
  const cwd: string;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };

  /** Simple token-budget estimate for workflow runs. */
  const budget: WorkflowBudget;
}
