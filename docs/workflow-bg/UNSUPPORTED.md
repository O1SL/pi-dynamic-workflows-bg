# Unsupported / partial parity decisions

`pi-dynamic-workflows-bg` intentionally remains a dynamic workflow extension, not a full replacement for `pi-subagents`. This document records capabilities that are unsupported or only partially supported after the parity push, why they are not implemented as full parity, and the current alternative.

## True JavaScript workflow graph checkpoint/resume

**Status:** unsupported.

A workflow script runs inside a Node `vm` as an async JavaScript function. Capturing and restoring its exact continuation would require serializing VM execution state: call stack, closures, pending promises, local variables, and the scheduler state of `parallel()` / `pipeline()`. Node does not expose a safe general-purpose continuation snapshot for this.

**Current alternative:**

- Every run persists `status.json`, `events.jsonl`, `output.md`, `result.json`, and child `sessions/`.
- `workflow_summary`, `workflow_events`, `workflow_result`, and `workflow_transcript` reconstruct what happened.
- `workflow_resume` continues a child session, not the original JS workflow graph.
- `workflow_extend` starts a linked follow-up workflow from a parent run's partial/final context without changing the parent.
- `workflow_replace_tail` cancels a running parent, waits for it to settle, then starts a linked replacement from its partial context.
- If the workflow process dies while `status: running`, recovery marks it `interrupted`.

**Future feasible direction:** step-level workflow recipes with explicit checkpoints, not arbitrary JS continuation restore.

## Full `pi-subagents` fleet TUI

**Status:** unsupported; textual inspection implemented.

`pi-subagents` owns a rich interactive fleet UI with keyboard navigation, transcript panes, nested runs, active state, and control actions. Rebuilding that TUI inside this extension would duplicate a large part of `pi-subagents`.

**Current alternative:**

- `workflow_status` / `/workflow-status`
- `workflow_summary` / `/workflow-summary`
- `workflow_events` / `/workflow-events`
- `workflow_transcript` / `/workflow-transcript`
- `workflow_worktrees` / `/workflow-worktrees`

These provide model-readable and human-readable inspection without an interactive fleet UI.

## Supervisor / intercom protocol

**Status:** unsupported.

A supervisor protocol requires a routed parent-child messaging system, paused/detached states, acknowledgement, timeouts, and UX for resolving child questions. `pi-subagents` already implements this for subagent sessions. Reimplementing it here would turn this workflow extension into a second subagent runtime.

**Current alternative:**

- Child agents should return blockers in their output.
- The parent can inspect via `workflow_summary`/`workflow_transcript`.
- The parent can continue a child after completion with `workflow_resume`.

## Robust live steer acknowledgement

**Status:** partial.

`workflow_steer` can send a steering message to a currently live child session in the same process using `session.steer()` or `sendUserMessage(..., { deliverAs: "steer" })`. It records `workflow.agent.steered` in `events.jsonl`.

It does **not** provide:

- delivery acknowledgement,
- recovery after restart,
- nested routing,
- supervisor UI,
- replay of missed steering messages.

**Current alternative:** use `workflow_steer` for best-effort live guidance; use `workflow_resume` after completion for reliable follow-up.

## Full child session revive parity

**Status:** partial.

`workflow_resume` reopens a persisted child session and sends a follow-up prompt. This supports multiple follow-ups and works for completed or failed child sessions.

It does **not** revive the exact previous live process, preserve pending tool calls, or restore the JavaScript workflow VM. It is closer to “continue this child transcript” than `pi-subagents` revive semantics.

## Advanced model fallback policy

**Status:** partial.

Basic same-model retry and fallback are implemented with:

```js
agent('...', {
  retry: 2,
  retryDelayMs: 1000,
  model: 'primary/model',
  fallbackModels: ['fallback/model']
})
```

`agent()` retries retryable provider/model failures once by default; `retry` and `retryDelayMs` tune this. Retryable provider/model failures can then use fallback models. Attempts are recorded in snapshot and `events.jsonl`.

Not implemented:

- provider-specific retry taxonomy,
- model-scope policy enforcement,
- thinking suffix compatibility handling,
- per-attempt artifact directories,
- structured fallback ledger comparable to `pi-subagents`.

## Worktree merge-back lifecycle

**Status:** partial.

Implemented:

- `isolation: "worktree"` creates detached worktrees,
- worktree paths are recorded,
- `workflow_worktrees` lists them,
- `workflow_worktree_cleanup` removes clean worktrees and refuses dirty ones unless `force:true`.

Not implemented:

- merge-back to the original worktree,
- conflict handling,
- dirty diff review UX,
- branch naming policy,
- long-lived worktree management.

## Full turn/tool budget parity

**Status:** partial.

Implemented:

- workflow-level `tokenBudget`,
- per-child `timeoutMs`,
- per-child `toolBudget.hard`,
- per-child `toolBudget.soft` model-visible nudge,
- budget telemetry in snapshot/events,
- basic post-run `turnBudget` enforcement.

Not implemented:

- live mid-turn turn-budget abort,
- steering “wrap up now” messages,
- full `pi-subagents` budget state machine,
- per-tool detailed lifecycle UI.

## `subagent_wait` as the canonical wait surface

**Status:** best effort only.

The extension registers a compatible `pi-subagents.background-work.v1` provider. This works in same-realm explicit extension loading, but global package auto-loading can isolate enough state that `subagent_wait` may not see workflow provider items.

**Canonical wait surface for this extension:** use `workflow_wait`.
