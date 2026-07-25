# Subagent-style parity status

This document tracks how `pi-dynamic-workflows-bg` compares to `pi-subagents` for production background orchestration.

## Implemented

| Capability | Status | Notes |
| --- | --- | --- |
| Background default execution | Implemented | `workflow` starts in background unless `foreground:true` is passed. |
| Foreground compatibility | Implemented | `foreground:true` preserves the original blocking workflow behavior. |
| Model-visible completion | Implemented | Completion uses `pi.sendMessage(..., { triggerTurn: true })`, so the parent model can consume results. |
| Native wait | Implemented | `workflow_wait` waits for one workflow and returns its result. Use this instead of relying on `subagent_wait`. |
| Native management tools | Implemented | `workflow_status`, `workflow_result`, `workflow_transcript`, `workflow_resume`, `workflow_cancel`, `workflow_wait`. |
| Human slash commands | Implemented | `/workflow-status`, `/workflow-result`, `/workflow-transcript`, `/workflow-resume`, `/workflow-cancel`. |
| Artifacts | Implemented | Each run writes `status.json`, `events.jsonl`, `output.md`, `result.json`, and child sessions under `sessions/`. |
| Durable run registry/recovery | Implemented (basic) | On extension load, historical `status.json` files are restored. Stale `running` runs from old processes become `interrupted`. |
| Reconciliation | Implemented (basic) | `ownerPid` prevents current-process runs from being falsely marked interrupted; old running records are reconciled to interrupted. |
| Events log | Implemented | `events.jsonl` records workflow lifecycle, phases, agent start/end/session/resume, completion/failure/cancel/interrupted. |
| Notification size limit | Implemented | Large model-visible notifications are truncated while full output remains in artifacts. |
| Completion batching | Implemented | Completed workflows are batched over a short debounce window. Failures/cancellations flush immediately. |
| Completion dedupe | Implemented | `notifiedIds` and persisted `notified` prevent duplicate notifications in the current/recovered process. |
| Token budget | Implemented | `workflow` accepts `tokenBudget`; exhausted budgets fail subsequent `agent()` calls. |
| Concurrency | Implemented | `workflow` accepts `concurrency`. |
| Child session persistence | Implemented | Child sessions are persisted in the run artifact directory and referenced in status/snapshot/events. |
| Transcript inspection | Implemented | `workflow_transcript` reads persisted child sessions by run id and optional agent selector. |
| Resume/revive after completion | Implemented (experimental) | `workflow_resume` reopens a persisted child session and sends a follow-up prompt. |
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
| Live inspection | Partial | `workflow_status`, `workflow_result`, and `workflow_transcript` provide textual inspection; no fleet TUI yet. |

## Not implemented yet

| Capability | Why not yet |
| --- | --- |
| Live steer of a running child | Requires holding live child session handles and a safe message injection channel while `agent()` is still executing. |
| Supervisor/intercom | Requires a parent/child question channel and paused/detached run states comparable to `pi-subagents`. |
| Full fleet view | Requires TUI state model, keyboard navigation, transcript panes, and active run tree rendering. |
| Worktree isolation | Requires creating, routing, validating, and cleaning git worktrees for `agent(..., { isolation: "worktree" })`. |
| Model fallback | Requires resolving alternate models and retrying child agent sessions on provider/model failures. |
| Turn/tool budgets for child agents | `tokenBudget` exists at workflow level; per-child turn/tool budget requires deeper integration with Pi child sessions. |
| Nested run tree | Workflow supports one level of `agent()` calls; nested workflow/subagent tracking is not represented as a tree. |
| True workflow graph resume | Current `workflow_resume` resumes a child session, not the JS workflow VM from a checkpoint. |

## Recommended next implementation order

1. Multi-resume QA and transcript-after-resume verification.
2. Result/history restoration E2E after reload/new Pi process.
3. Per-child budget and timeout options where Pi APIs allow it.
4. Model fallback feasibility spike.
5. Worktree isolation feasibility spike.
6. TUI/fleet inspection only after core state model is stable.
