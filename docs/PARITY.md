# Subagent-style parity status

This document tracks how `pi-dynamic-workflows-bg` compares to `pi-subagents` for production background orchestration. For deliberate non-goals and detailed limitations, see [`UNSUPPORTED.md`](UNSUPPORTED.md).

## Implemented

| Capability | Status | Notes |
| --- | --- | --- |
| Background default execution | Implemented | `workflow` starts in background unless `foreground:true` is passed. |
| Foreground compatibility | Implemented | `foreground:true` preserves the original blocking workflow behavior. |
| Model-visible completion | Implemented | Completion uses `pi.sendMessage(..., { triggerTurn: true })`, so the parent model can consume results. |
| Native wait | Implemented | `workflow_wait` waits for one workflow and returns its result. Use this instead of relying on `subagent_wait`. |
| Native management tools | Implemented | `workflow_status`, `workflow_result`, `workflow_summary`, `workflow_transcript`, `workflow_events`, `workflow_worktrees`, `workflow_worktree_cleanup`, `workflow_resume`, `workflow_cancel`, `workflow_wait`. |
| Human slash commands | Implemented | `/workflow-status`, `/workflow-result`, `/workflow-transcript`, `/workflow-resume`, `/workflow-cancel`. |
| Artifacts | Implemented | Each run writes `status.json`, `events.jsonl`, `output.md`, `result.json`, and child sessions under `sessions/`. |
| Durable run registry/recovery | Implemented (basic) | On extension load, historical `status.json` files are restored. Stale `running` runs from old processes become `interrupted`. |
| Reconciliation | Implemented (basic) | `ownerPid` prevents current-process runs from being falsely marked interrupted; old running records are reconciled to interrupted. |
| Events log | Implemented | `events.jsonl` records workflow lifecycle, phases, agent start/end/session/resume, completion/failure/cancel/interrupted. `workflow_events` and `/workflow-events` inspect it. |
| Notification size limit | Implemented | Large model-visible notifications are truncated while full output remains in artifacts. |
| Completion batching | Implemented | Completed workflows are batched over a short debounce window. Failures/cancellations flush immediately. |
| Completion dedupe | Implemented | `notifiedIds` and persisted `notified` prevent duplicate notifications in the current/recovered process. |
| Token budget | Implemented | `workflow` accepts `tokenBudget`; exhausted budgets fail subsequent `agent()` calls. |
| Concurrency | Implemented | `workflow` accepts `concurrency`. |
| Per-child timeout | Implemented | `agent(..., { timeoutMs })` aborts slow child agents and returns `null` for that branch under existing failure semantics. |
| Per-child tool budget | Implemented | `agent(..., { toolBudget: { soft, hard, block } })` wraps child tools, appends a model-visible soft nudge at the soft threshold, and blocks configured tools after the hard limit. |
| Per-child turn budget | Implemented (basic) | `agent(..., { turnBudget: { maxTurns, graceTurns } })` adds explicit prompt guidance and post-run enforcement based on assistant turn count. It does not live-abort mid-turn. |
| Per-child model selection | Implemented | `agent(..., { model: "provider/model" })` is passed through and resolved against Pi's model registry when using real child sessions. |
| Automatic fallback models | Implemented | `agent(..., { model, fallbackModels })` retries retryable provider/model failures with fallback models. Non-retryable failures do not retry. Attempts are recorded in status snapshot and `events.jsonl`. |
| Worktree isolation | Implemented (basic) | `agent(..., { isolation: "worktree" })` creates a detached git worktree for real child sessions and records its path in status/events. | 
| Worktree listing/cleanup | Implemented (basic) | `workflow_worktrees` lists created worktrees; `workflow_worktree_cleanup` removes clean worktrees and refuses dirty worktrees unless `force:true` is passed. Forced cleanup uses `git worktree remove --force` and falls back to filesystem removal. |
| Child session persistence | Implemented | Child sessions are persisted in the run artifact directory and referenced in status/snapshot/events. |
| Transcript inspection | Implemented | `workflow_transcript` reads persisted child sessions by run id and optional agent selector. |
| Resume/revive after completion | Implemented (experimental) | `workflow_resume` reopens a persisted child session and sends a follow-up prompt. |
| Live steer running child | Implemented (experimental) | `workflow_steer` sends a steering message to a currently running child session when the live session handle is still available in the current process. |
| Provider error propagation | Implemented | Child assistant messages ending with provider/tool errors now fail the workflow instead of returning empty text. |
| CI | Implemented | GitHub Actions runs `npm ci`, `npm run qa:full`, and `npm pack --dry-run`. |
| Local QA | Implemented | `qa:full` covers manager, extension, batching, recovery, artifacts, transcript, wait, cancel, failure, token budget, etc. |
| Real Pi E2E | Partially implemented | Verified background completion, failure, foreground mode, `workflow_wait`, `workflow_transcript`, and `workflow_resume` on installed package. |

## Best-effort / partial

| Capability | Status | Notes |
| --- | --- | --- |
| `subagent_wait` provider integration | Best effort | Same-realm explicit loading can track workflow provider items. Global package auto-loading can isolate realms; use `workflow_wait` for reliable waits. |
| Cross-restart history access | Partial | Completed/interrupted runs restore into a new manager. Running work cannot resume after process exit. |
| Resume/revive | Partial | `workflow_resume` can continue a persisted child session after completion/failure. It does not restart the original workflow graph or update the original workflow result. |
| Live inspection | Partial | `workflow_status`, `workflow_result`, `workflow_summary`, `workflow_events`, and `workflow_transcript` provide textual inspection; no fleet TUI yet. |

## Not implemented yet

| Capability | Why not yet |
| --- | --- |
| Live steer robustness | Basic live steer exists. It is current-process only, has no delivery acknowledgement protocol, no queued recovery after restart, and no supervisor UX comparable to `pi-subagents`. |
| Supervisor/intercom | Requires a parent/child question channel and paused/detached run states comparable to `pi-subagents`. |
| Full fleet view | Requires TUI state model, keyboard navigation, transcript panes, and active run tree rendering. |
| Worktree merge lifecycle | Basic worktree creation/listing/cleanup exists, including dirty-state cleanup protection. Automatic merge-back and multi-worktree lifecycle policies are not implemented. |
| Model fallback edge cases | Fallback retry and attempt ledger exist, but provider-specific retry classification and model-scope policy parity with `pi-subagents` are not complete. |
| Advanced budget state | Hard tool-call blocking, soft tool nudges, and post-run turnBudget enforcement exist. Live mid-turn abort, wrap-up steering, and parity with `pi-subagents` budget state reporting are not implemented. |
| Nested run tree | Workflow supports one level of `agent()` calls; nested workflow/subagent tracking is not represented as a tree. |
| True workflow graph resume | Current `workflow_resume` resumes a child session, not the JS workflow VM from a checkpoint. |

## Recommended next implementation order

1. Multi-resume QA and transcript-after-resume verification.
2. Result/history restoration E2E after reload/new Pi process.
3. Per-child budget and timeout options where Pi APIs allow it.
4. Model fallback feasibility spike.
5. Worktree isolation feasibility spike.
6. TUI/fleet inspection only after core state model is stable.
