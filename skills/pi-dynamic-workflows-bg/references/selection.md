# Selection: When to Use Workflow

Use `workflow` when the task needs dynamic JavaScript orchestration across multiple child agents. Prefer ordinary tools for simple single-step operations, `pi-subagents` for governed agent execution, and `pi-intercom` for cross-session coordination.

## Gate

The `workflow` tool's own policy requires an explicit user request for workflow/fan-out/multi-agent orchestration. If the user has not asked for those capabilities, prefer ordinary tools or `pi-subagents` even when the task is technically decomposable. Do not start a workflow merely because it would be useful.

## Decision table

| Need | Use |
| --- | --- |
| One simple file read/edit/search or quick command | Ordinary tools (`read`, `edit`, `bash`) |
| Multi-step fan-out/fan-in with natural JS `if`/loops/data flow | `workflow` |
| Parallel review/research/inspection with a final synthesis | `workflow` + `parallel()` |
| Item-by-item staged processing | `workflow` + `pipeline()` |
| Background run with status/result/events/transcripts | `workflow` |
| A named reviewer/worker/scout with stronger role policy, fleet UI, intercom, supervisor, or acceptance evidence | `pi-subagents` |
| Coordinating independent Pi sessions or asking another session a question | `pi-intercom` |
| Long-running human-in-the-loop supervision | `pi-subagents` (`workflow_steer` is only a single live nudge, not durable supervision) |
| Steer a live child agent mid-run (experimental, current-process best effort) | `workflow_steer` |
| Continue after an interrupted/partial workflow | `workflow_extend` |
| Cancel a running workflow and replace its direction | `workflow_replace_tail` |
| Continue only one child agent conversation | `workflow_resume` |
| Resume the exact JS workflow VM, closures, or pending promises | Not supported |

## Foreground versus background

Default to background mode:

```json
{ "script": "..." }
```

Background mode returns a run id immediately and persists artifacts. Use it for anything that may take more than a moment or should be inspectable later.

Use foreground only when the user explicitly wants to wait in the current assistant turn:

```json
{ "script": "...", "foreground": true }
```

Foreground blocks the tool call. Do not use it for long-running fan-out unless the user asked for inline completion.

## What workflow is especially good at

- Dynamic conditions based on early agent results.
- Dynamic loops over data discovered during the workflow.
- Fan-out then synthesis.
- Pipelines where each item moves through ordered stages.
- Workflows that need retry/fallback models, timeouts, tool/turn budgets, or isolated worktrees.
- Parent/child adaptive work where the next script depends on a previous run's artifacts.

## What workflow should not become

- A replacement for `pi-subagents` fleet/supervisor/intercom.
- A declarative chain DSL or graph annotation language.
- A checkpoint/resume engine for arbitrary JavaScript VMs.
- A mechanism for coordinating multiple independent Pi sessions.
