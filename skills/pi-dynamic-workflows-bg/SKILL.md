---
name: pi-dynamic-workflows-bg
description: |
  Orchestrate deterministic JavaScript workflows with agent(), parallel(),
  and pipeline(). Use for dynamic multi-step fan-out/fan-in workflows,
  background artifact-backed execution, adaptive follow-ups, and result synthesis
  where natural JS control flow is preferred over declarative agent chains.
---

# Pi Dynamic Workflows (Background)

This skill is for the parent orchestrator only. Do not ask child workflow agents to author or run nested workflows unless the parent explicitly assigns that responsibility.

Use this skill when you need to run or inspect a JavaScript workflow, manage background workflow artifacts, continue work from an interrupted/partial run, or choose between natural-JS workflow orchestration and the governance-oriented `pi-subagents` runtime.

## How to use this router

Read the matching reference file before acting. Paths are relative to this `SKILL.md`; resolve them against `skills/pi-dynamic-workflows-bg/` and load them with the read tool.

| Task | Read |
| --- | --- |
| Decide whether to use workflow, ordinary tools, `pi-subagents`, or `pi-intercom`; choose foreground versus background execution | `references/selection.md` |
| Author workflow scripts with `agent()`, `parallel()`, `pipeline()`, `phase()`, structured output, retry/fallback, budgets, worktrees, and JSON results | `references/authoring.md` |
| Wait, inspect, summarize, view events/transcripts, cancel, recover interrupted runs, or resume a child session | `references/lifecycle.md` |
| Continue from a parent workflow using `workflow_extend`, cancel/replace a running parent using `workflow_replace_tail`, and use the read-only `continuation` global correctly | `references/continuations.md` |

For broad or uncertain requests, read `references/selection.md` and `references/authoring.md` first. For interrupted/follow-up work, also read `references/lifecycle.md` and `references/continuations.md`.

## Always-on constraints

- Keep workflow authoring natural JavaScript; do not invent `graph.*()` APIs, declarative chain syntax, imports, or nondeterministic helpers.
- Use background mode by default. Only use `foreground:true` when the user explicitly wants inline completion in the current turn.
- Use `workflow_wait` when this turn must consume a background result; do not repeatedly poll slash commands from the model.
- Treat artifacts as the source of truth: inspect `workflow_status`, `workflow_result`, `workflow_summary`, `workflow_events`, and `workflow_transcript` before deciding follow-up work.
- Do not edit or resume a running JavaScript workflow VM. Use `workflow_extend` for linked follow-up work, or `workflow_replace_tail` to cancel and replace a running parent.
- Do not confuse `workflow_resume` with workflow recovery: it continues one child agent session, not the original JS workflow.
- In linked workflows, use `continuation.parent.runId`, `continuation.parent.result`, `continuation.parent.outputPath`, and `continuation.parent.snapshot`. Never use `continuation.id` or `continuation.result`.
- Return only strict JSON values from workflow scripts: no BigInt, undefined, Map/Set, functions, circular values, or non-plain objects.
- Failed child branches return `null` by default; check child errors and `completed with child errors` output before synthesizing conclusions.
- Do not use `agentType` as if it selected a configured `pi-subagents` role; it is only a role hint inserted into the child prompt.
