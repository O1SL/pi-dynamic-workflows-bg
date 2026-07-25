# pi-dynamic-workflows-bg

> Background-first dynamic workflows for [Pi](https://github.com/earendil-works/pi).

This is a fork of `pi-dynamic-workflows` that keeps the same deterministic JavaScript workflow DSL, but changes the default execution model: **workflow runs start in the background and return a run id immediately**. When a run completes, the extension sends a model-visible custom message with `triggerTurn: true`, so the parent agent wakes up and can consume the result, similar to background subagent completion notifications.

## Install

```bash
pi install git:github.com/O1SL/pi-dynamic-workflows-bg
# or from a local checkout
pi install /path/to/pi-dynamic-workflows-bg
```

Then in Pi:

```text
/reload
```

## Usage

Ask Pi for a workflow normally:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The `workflow` tool returns immediately:

```text
Started background workflow inspect_project.
Run ID: 20260725123000-inspect-project
Artifacts: ~/.pi/agent/background-workflows/runs/20260725123000-inspect-project
Use /workflow-status 20260725123000-inspect-project or /workflow-result 20260725123000-inspect-project to inspect it.
```

When the workflow finishes, Pi receives a model-visible custom message and renders a transcript entry:

```text
Background workflow completed: inspect_project
...
Result:
```json
{ ... }
```
```

### Commands

```text
/workflow-status                  # list runs from this Pi process
/workflow-status <id-prefix>      # detailed status
/workflow-result <id-prefix>      # show final result / current snapshot
/workflow-cancel <id-prefix>      # cancel a running workflow
```

The model also gets explicit management tools so it can consume background results without relying on slash commands or `subagent_wait`:

```text
workflow_status                   # list or inspect runs
workflow_result                   # read current/final result
workflow_cancel                   # cancel a running workflow
workflow_wait                     # wait for one run and return its result
```

Artifacts are written to:

```text
~/.pi/agent/background-workflows/runs/<run-id>/
├── status.json
├── output.md
└── result.json
```

## Foreground escape hatch

The tool schema includes:

```json
{ "foreground": true }
```

Use it only when you explicitly want the old behavior: block the current assistant turn until the workflow completes and return the result inline.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Available globals are the same as the upstream plugin: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `process.cwd()`, and `budget`.

## Notes

See [`docs/PARITY.md`](docs/PARITY.md) for the detailed parity matrix versus `pi-subagents`, including implemented and partial capabilities. See [`docs/UNSUPPORTED.md`](docs/UNSUPPORTED.md) for deliberate non-goals and deeper limitations.

- Background completion uses `pi.sendMessage({ customType: "background-workflow-result", ... }, { triggerTurn: true })`, not a UI-only custom entry. The result is visible to the parent model on the next turn.
- Prefer `workflow_wait` when the current model turn must block until a specific workflow finishes. It is native to this extension and does not depend on `pi-subagents`.
- The extension registers a best-effort compatible `pi-subagents.background-work.v1` provider. This works when both extensions share the same Pi extension realm (verified with explicit `-e` loading), but global package auto-loading can isolate realms enough that `subagent_wait` does not see workflow provider items. Completion messages remain model-visible either way.
- Background progress is persisted to artifact files. Live inline tool streaming is only available in `foreground:true` mode.
- Runs are in-memory for cancellation/status during the current Pi process. If Pi restarts, completed artifacts remain on disk, but running jobs are not resumed.
- This fork intentionally keeps the original `workflow` tool name so existing prompts keep working, but changes the default mode to background.

## QA

```bash
npm run build
npm run qa:smoke
```

`qa:smoke` runs:

1. `qa-smoke.mjs` — mock-agent background execution, notification callback, and artifact checks.
2. `qa-extension-smoke.mjs` — extension registration, model-visible `sendMessage(... triggerTurn:true)` completion, and same-realm `pi-subagents.background-work.v1` provider checks.

`qa:full` additionally runs `qa-manager-comprehensive.mjs`, covering success, failure, no-agent validation, cancellation, concurrent id collision prevention, provider-active visibility, session-scoped wait, and artifact outputs.

## License

MIT
