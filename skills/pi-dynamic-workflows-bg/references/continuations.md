# Continuations: Extend and Replace Tail

Use linked workflows when the next step depends on a parent run's partial or final state. Never try to edit or resume the parent's JavaScript VM.

## `workflow_extend`

Use `workflow_extend` when a parent workflow has already produced useful evidence and the parent itself should remain unchanged. The parent may be completed, failed, cancelled, or interrupted.

The child is a new independent run with its own id, artifacts, graph, and completion notification. It also receives a read-only `continuation` context.

```js
export const meta = {
  name: 'security_followup',
  description: 'Follow up on parent discovery findings',
}

phase('Follow-up')
const review = await agent(
  `Parent output: ${continuation.parent.outputPath}\n` +
  `Parent result: ${JSON.stringify(continuation.parent.result)}`,
  { label: 'security follow-up' },
)

return {
  parentRunId: continuation.parent.runId,
  review,
}
```

## `workflow_replace_tail`

Use `workflow_replace_tail` only when the parent is still running and its current direction is wrong. The tool validates the replacement script before cancelling the parent, waits for the parent to settle, then starts a linked replacement workflow.

Do not use `workflow_replace_tail` for a terminal parent; use `workflow_extend`.

## Correct `continuation` fields

Always access parent context through `continuation.parent`:

```js
continuation.parent.runId
continuation.parent.name
continuation.parent.status
continuation.parent.artifactDir
continuation.parent.statusPath
continuation.parent.outputPath
continuation.parent.resultPath
continuation.parent.eventsPath
continuation.parent.snapshot
continuation.parent.result
continuation.parent.resultTruncated
```

These are wrong and must not be used:

```js
continuation.id
continuation.result
continuation.outputPath
```

The `continuation` object is cloned and deep-frozen. It is context, not a mutable shared state channel.

## Parent result truncation

If `continuation.parent.resultTruncated` is true, do not embed the truncated result in a large prompt. Reference the parent artifact paths instead, especially:

```js
continuation.parent.outputPath
continuation.parent.resultPath
```

Give the child enough context to decide what to inspect rather than forcing the whole parent output into one prompt.

## What continuations do not do

They do not:

- continue the same JavaScript call stack;
- preserve local variables, closures, or pending promises;
- resume `parallel()` or `pipeline()` scheduler state;
- merge child agents into the parent's graph;
- automatically copy files between run artifact directories.

If exact step-level resumption is required, use smaller stage workflows rather than one large arbitrary-JS workflow.

## Example: discovery then focused review

Parent workflow:

```js
export const meta = { name: 'discovery', description: 'Find high-risk areas' }
phase('Discovery')
const findings = await agent('Find the top two risks.', { label: 'discovery' })
return { findings }
```

After the parent completes, extend it:

```js
export const meta = { name: 'security_followup', description: 'Review security risks from parent' }
phase('Security')
const parentSummary = continuation.parent.result
const review = await agent(
  `Parent run: ${continuation.parent.runId}\n` +
  `Findings: ${JSON.stringify(parentSummary)}\n` +
  `Perform one focused security review.`,
  { label: 'security review' },
)
return { parentRunId: continuation.parent.runId, review }
```
