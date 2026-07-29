# Authoring Workflow Scripts

Workflow scripts are deterministic JavaScript. They must begin with a literal meta export and must call `agent()` at least once.

## Required skeleton

```js
export const meta = {
  name: 'short_snake_case',
  description: 'Non-empty human description',
}

phase('Discover')
const discovery = await agent('Inspect the repository and summarize key modules.', {
  label: 'discovery',
})

return { discovery }
```

Rules:

- First statement must be `export const meta = { name, description }`.
- `meta.name` and `meta.description` must be non-empty strings.
- Write plain JavaScript. No TypeScript syntax, imports, `require()`, `fs`, `Date.now()`, `Math.random()`, `new Date()`, dynamic codegen, timers, or arbitrary globals.
- `meta.phases` is optional upfront-outline metadata only; actual progress comes from runtime `phase(title)` calls. Do not declare `meta.phases` without calling `phase()`.
- Return a strict JSON value only: `null`, booleans, finite numbers, strings, arrays, and plain objects. Do not return BigInt, undefined, Map/Set, functions, circular values, or non-plain objects.

## Available globals

- `agent(prompt, opts)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `phase(title)`
- `log(message)`
- `args`
- `cwd` and `process.cwd()`
- `budget`
- `continuation` (only for linked workflows started with `workflow_extend` or `workflow_replace_tail`)

## `agent(prompt, opts)`

Every child call should have a short unique label, usually 2-5 words:

```js
const review = await agent('Review the implementation for correctness.', {
  label: 'correctness review',
})
```

Useful options:

| Option | Meaning |
| --- | --- |
| `label` | Human-readable child label for status, graph, transcripts, and summaries. |
| `phase` | Override the current runtime phase. |
| `schema` | JSON Schema for structured child output. |
| `model` | Request a specific child model, e.g. `provider/model-id`. |
| `fallbackModels` | Fallback models after retryable primary-model failures. |
| `retry`, `retryDelayMs` | Same-model retry budget and delay. Default retry is one attempt. |
| `timeoutMs` | Abort this child after a time limit. |
| `toolBudget` | Tool-call soft warning and hard blocking, e.g. `{ soft: 20, hard: 30, block: '*' }`. |
| `turnBudget` | Prompt guidance plus post-run assistant-turn enforcement. |
| `isolation: 'worktree'` | Run the child in a detached git worktree. |
| `agentType` | Role hint text only. It does not select a configured `pi-subagents` agent or change capabilities. |

## Structured output

Use plain JSON Schema syntax, not TypeBox constructors:

```js
const schema = {
  type: 'object',
  properties: {
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['risks'],
}

const result = await agent('Return concise risks as JSON.', {
  label: 'risk extraction',
  schema,
})
```

When `schema` is present, treat the returned value as unknown until narrowed in the workflow.

## Parallel fan-out

`parallel()` takes functions, not promises:

```js
const reviews = await parallel([
  () => agent(`Review correctness:\n${discovery}`, { label: 'correctness' }),
  () => agent(`Review tests:\n${discovery}`, { label: 'tests' }),
  () => agent(`Review security:\n${discovery}`, { label: 'security' }),
])
```

Results preserve input order. Failed branches return `null` by default; check for `null` before synthesis.

## Pipeline

Use `pipeline(items, ...stages)` for item-by-item staged processing. Each item moves sequentially through stages; different items can run concurrently.

```js
const audits = await pipeline(modules,
  (value, module) => agent(`Scan ${module.path}`, { label: `scan ${module.name}` }),
  (previous, module) => agent(`Review ${module.path}\nPrevious:\n${JSON.stringify(previous)}`, {
    label: `review ${module.name}`,
  }),
)
```

Each stage receives `(previousValue, originalItem, index)`.

## Natural control flow

Use ordinary JavaScript when the next work depends on earlier results:

```js
phase('Discovery')
const discovery = await agent('Identify top risks.', { label: 'discovery' })

const followups = []
if (discovery.includes('security')) {
  followups.push(() => agent('Perform security review.', { label: 'security review' }))
}
if (discovery.includes('performance')) {
  followups.push(() => agent('Perform performance review.', { label: 'performance review' }))
}

phase('Follow-up')
const reviews = followups.length ? await parallel(followups) : []
return { discovery, reviews }
```

## Retry, fallback, timeout, and budgets

`agent()` retries retryable provider/model failures once by default. Tune only when needed:

```js
await agent('Inspect source modules.', {
  label: 'source modules',
  model: 'provider/model-id',
  fallbackModels: ['provider/fallback-model'],
  retry: 2,
  retryDelayMs: 1000,
  timeoutMs: 120000,
})
```

`toolBudget` blocks tools after a hard count and can send a soft wrap-up hint. `turnBudget` tells the child how many assistant turns it should use and is enforced after the run. `tokenBudget` at the workflow level is a post-completion output-size estimate, not a hard model-token cap and it does not reserve budget for in-flight children.

## Worktree isolation

Use only when child changes must not touch the primary checkout:

```js
await agent('Implement the fix in an isolated checkout.', {
  label: 'isolated fix',
  isolation: 'worktree',
})
```

Worktrees are detached. There is no automatic merge-back; inspect and integrate changes deliberately.

## Result shape

For multi-agent workflows, return a compact JSON object that includes status/verdict and the important outputs:

```js
const risks = await parallel([
  () => agent('Check correctness.', { label: 'correctness' }),
  () => agent('Check tests.', { label: 'tests' }),
])

return {
  ok: risks.every(Boolean),
  risks,
  summary: await agent(`Synthesize:\n${JSON.stringify(risks)}`, { label: 'synthesis' }),
}
```

If any child returned `null`, mark the result accordingly instead of pretending every branch succeeded. The runtime surfaces completed runs with failed children as `completed with child errors`.
