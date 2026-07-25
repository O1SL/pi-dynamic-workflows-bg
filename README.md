# pi-dynamic-workflows-bg

> Background-first dynamic workflows for [Pi](https://github.com/earendil-works/pi).

This is a fork of `pi-dynamic-workflows` that keeps the same deterministic JavaScript workflow DSL, but changes the default execution model: **workflow runs start in the background and return a run id immediately**. When a run completes, the extension appends a result card to the Pi transcript, similar to background subagent completion notifications.

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

When the workflow finishes, Pi appends a transcript entry:

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

- Background progress is persisted to artifact files. Live inline tool streaming is only available in `foreground:true` mode.
- Runs are in-memory for cancellation/status during the current Pi process. If Pi restarts, completed artifacts remain on disk, but running jobs are not resumed.
- This fork intentionally keeps the original `workflow` tool name so existing prompts keep working, but changes the default mode to background.

## License

MIT
