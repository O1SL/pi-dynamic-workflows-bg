# workflow continuation UI contract

This document defines the small, stable contract between `pi-dynamic-workflows-bg` and pi-web for linked follow-up workflows.

## Goal

A user or model may inspect partial/final results from one workflow and decide what to do next. The runtime must **not mutate a running JavaScript VM**. Instead it creates a new, linked workflow run.

Two operations exist:

| Operation | Parent requirement | Semantics |
|---|---|---|
| `workflow_extend` | any known run | starts a linked follow-up without changing the parent |
| `workflow_replace_tail` | parent must be `running` | cancels and settles parent, then starts a linked replacement from its partial context |

The child is a normal standalone workflow run. It has its own run id, artifacts, lifecycle, status file, completion notification, and graph.

---

## Runtime APIs

### `workflow_extend`

```json
{
  "parentId": "202607...-discovery",
  "script": "export const meta = ...",
  "args": {},
  "concurrency": 2,
  "tokenBudget": 8000
}
```

Response details:

```json
{
  "action": "extend",
  "id": "child-run-id",
  "parentId": "parent-run-id",
  "artifactDir": "...",
  "statusPath": "..."
}
```

### `workflow_replace_tail`

Same fields plus optional `timeoutMs`. It fails when the parent is terminal; callers should use `workflow_extend` in that case.

Response details:

```json
{
  "action": "replace_tail",
  "id": "child-run-id",
  "parentId": "parent-run-id",
  "artifactDir": "...",
  "statusPath": "..."
}
```

---

## Persisted contract

The child run's `status.json` has an optional top-level `continuation` field:

```jsonc
{
  "id": "child-run-id",
  "status": "running",
  "continuation": {
    "version": 1,
    "kind": "extend", // or "replace_tail"
    "createdAt": "2026-07-28T...Z",
    "parent": {
      "runId": "parent-run-id",
      "name": "discovery",
      "description": "...",
      "status": "completed", // parent status at child creation
      "artifactDir": "/.../parent-run-id",
      "statusPath": "/.../status.json",
      "outputPath": "/.../output.md",
      "resultPath": "/.../result.json",
      "eventsPath": "/.../events.jsonl",
      "startedAt": "...",
      "updatedAt": "...",
      "completedAt": "...",
      "snapshot": {
        "phases": ["Discovery"],
        "currentPhase": "Discovery",
        "agents": [
          {
            "id": 1,
            "agentRunId": "a1",
            "label": "repo scan",
            "status": "done",
            "resultPreview": "...",
            "durationMs": 1200,
            "attempts": []
          }
        ]
      },
      "result": { "...": "..." },
      "resultTruncated": false
    }
  },
  "snapshot": { "...": "normal workflow snapshot" }
}
```

### Contract guarantees

- `continuation` is additive and optional; existing UI must ignore it safely.
- `parent.runId` is the canonical relationship key.
- Parent remains a distinct run; the UI must not merge child agents into the parent run.
- `kind` is exactly `extend` or `replace_tail`.
- `replace_tail` parent normally ends as `cancelled`; `extend` leaves parent unchanged.
- The parent result is JSON-cloned when possible and capped at 48,000 serialized characters. `resultTruncated:true` means UI should prefer the parent `outputPath`/`resultPath` for the complete payload.
- Absolute artifact paths are existing runtime fields. Treat them as display/open-file data only; do not turn them into browser-accessible paths.

---

## Current pi-web integration points

The current local pi-web implementation already has the required polling path and workflow-card state flow:

```text
~/dev/pi-web/app/api/workflows/[id]/route.ts
~/dev/pi-web/lib/workflow-run.ts
~/dev/pi-web/components/WorkflowRunCard.tsx
~/dev/pi-web/components/WorkflowDagView.tsx
```

Relevant current behavior:

- `app/api/workflows/[id]/route.ts` reads `~/.pi/agent/background-workflows/runs/<id>/status.json` and returns a selected envelope subset.
- `lib/workflow-run.ts` parses the workflow tool response, then merges polled `status.snapshot` through `mergeBackgroundStatus()`.
- `components/WorkflowRunCard.tsx` polls `/api/workflows/:id` while a background run is active.
- `WorkflowDagView` already renders the per-run graph; continuation is deliberately a run-level relationship, not a new graph edge.

## pi-web minimal implementation

The existing workflow polling endpoint already reads the correct `status.json` file:

```text
GET /api/workflows/:id
```

It currently returns a selected subset of the envelope, so the Web UI Agent needs one additive route field:

```ts
continuation: status.continuation
```

Minimal UI cost:

1. Add optional `continuation` to the route response and parsed `WorkflowRun` model.
2. Preserve it in `mergeBackgroundStatus()`.
3. In a workflow card/panel, when present, render a compact neutral relation chip:

```text
↳ Follow-up of <parent name/run id>
```

For `replace_tail`:

```text
↳ Replacement of <parent name/run id>
```

3. Make the parent run id clickable if pi-web already knows how to open a run by id. Otherwise show it as copyable text.
4. Do not add graph edges across separate runs in Phase 1. Cross-run DAG layout is intentionally out of scope.
5. If `resultTruncated:true`, expose an "open parent output" affordance using the existing file-open mechanism, not by embedding the full result in the card.

Suggested rendered copy:

```text
Follow-up workflow · parent: 202607...-discovery
Replacement workflow · cancelled parent: 202607...-discovery
```

---

## Runtime workflow script contract

A linked child receives a read-only global:

```js
continuation
```

Example:

```js
export const meta = {
  name: 'security_followup',
  description: 'Follow up based on discovery findings',
}

phase('Follow-up')
const result = await agent(
  `Review the parent result. Parent output: ${continuation.parent.outputPath}\n` +
  `Parent summary: ${JSON.stringify(continuation.parent.result)}`,
  { label: 'security review' },
)

return { parentRunId: continuation.parent.runId, result }
```

For ordinary workflows:

```js
continuation === undefined
```

The object is cloned and deep-frozen before entering the VM. It is context, not a shared mutable state channel.

---

## Explicit non-goals

This contract does **not** provide:

- editing/replacing a running JS script in place;
- preserving JS locals/closures/promises across workflows;
- a shared mutable variable environment;
- graph checkpoint/resume;
- cross-run graph edges;
- automatic parent/child orchestration in the UI.

These restrictions are intentional: linked follow-up runs solve the real adaptive-workflow use case while keeping runtime state, artifacts, recovery, and UI behavior stable.
