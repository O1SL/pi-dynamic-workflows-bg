# Lifecycle, Inspection, and Recovery

Background workflows persist their lifecycle under:

```text
~/.pi/agent/background-workflows/runs/<run-id>/
├── status.json
├── events.jsonl
├── output.md
├── result.json   # guaranteed for successful runs
└── sessions/
```

Use tools, not manual file edits, for normal inspection and control.

## Tool map

| Need | Tool |
| --- | --- |
| Start a workflow | `workflow` |
| Wait for a result in the current turn | `workflow_wait` |
| List or inspect a run | `workflow_status` |
| Read current/final result | `workflow_result` |
| One-page diagnostics and next actions | `workflow_summary` |
| Lifecycle events | `workflow_events` |
| Child agent transcript | `workflow_transcript` |
| Stop a running workflow | `workflow_cancel` |
| Start linked follow-up work | `workflow_extend` |
| Cancel and replace a running parent | `workflow_replace_tail` |
| Continue one child session | `workflow_resume` |
| Inspect workflow-created worktrees | `workflow_worktrees` |
| Clean workflow-created worktrees | `workflow_worktree_cleanup` |
| Dry-run/delete old terminal artifacts | `workflow_prune` |

## Waiting

Use `workflow_wait` when the current assistant turn must consume a background result:

```json
{ "id": "202607..." }
```

Wait for all active workflows in the current session with:

```json
{ "all": true }
```

Do not repeatedly call slash commands from the model just to poll. Slash commands are primarily for humans; tools are the canonical model-facing interface.

## Interruption and restart

If Pi or the host stops while a workflow is running, recovery marks the old running record as:

```text
interrupted
```

The original JavaScript VM, closures, local variables, pending promises, and `parallel()`/`pipeline()` scheduler state are not restored. Do not tell the user or another agent that the same workflow will simply continue from the exact `await` point.

Before deciding next work, inspect:

1. `workflow_summary` for completed/failed agents and artifacts.
2. `workflow_events` for lifecycle detail.
3. `workflow_transcript` for relevant child sessions.
4. `workflow_result` if the run completed or partially returned.

Then choose one of the explicit recovery paths below.

## Continue a child session

`workflow_resume` reopens one persisted child session and sends a follow-up prompt. It is appropriate when the useful state is in that child's conversation.

It is not:

- resumption of the original JS workflow;
- resumption of closures, locals, or pending promises;
- continuation of `parallel()` or `pipeline()` scheduling.

## Start linked follow-up work

Use `workflow_extend` when a parent run (completed or interrupted) has enough partial/final evidence to plan new work. It starts a new independent workflow with a read-only `continuation` context. See `references/continuations.md`.

## Cancel and replace a running parent

Use `workflow_replace_tail` only when a running parent is going in the wrong direction. It validates the replacement script, cancels the parent, waits for it to settle, then starts a linked replacement workflow. See `references/continuations.md`.

## Child failures

Failed child branches return `null` by default. A workflow can therefore return normally even when some children failed. When this happens, status/result/summary output should disclose:

```text
completed with child errors
```

Always inspect `errorCount`, failed agent labels, and `workflow_events` before synthesizing conclusions from partial fan-out results.

## Events, summaries, and transcripts

- `workflow_events` shows lifecycle records and is best for debugging order/failures/continuations.
- `workflow_summary` shows one-page status, artifacts, child sessions, worktrees, attempts, budgets, and suggested next actions.
- `workflow_transcript` reads a child session transcript by label substring or index. Transcript paths are constrained to the run artifact directory.

## Pruning

`workflow_prune` is safe by default: it dry-runs and never deletes running workflows. Use `dryRun:false` or `/workflow-prune --delete` only when you intentionally want to remove old terminal artifacts. Slash command deletion is for humans; models should prefer dry-run first.
