# pi-dynamic-workflows-bg 建设总结与接手指南

本文是 `pi-dynamic-workflows-bg` 的中文总 README，融合了建设总结、产品方案、技术方案、验收标准、踩坑记录和后续接手建议。后续 Agent 接手开发时，优先阅读本文，再看同目录下的 `PARITY.md`、`UNSUPPORTED.md`，以及上级目录的 `../PIWEB_GRAPH_CONTRACT.md`。

仓库：<https://github.com/O1SL/pi-dynamic-workflows-bg>  
本地路径：`/Users/bytedance/Desktop/AI项目/Pi/pi-dynamic-workflows-bg`  
Pi 安装源：`git:github.com/O1SL/pi-dynamic-workflows-bg`

---

## 1. 项目定位

`pi-dynamic-workflows-bg` 是一个 **background-first JavaScript workflow runtime for Pi**。

它保留原版 `pi-dynamic-workflows` 的核心体验：

```js
agent()
parallel()
pipeline()
phase()
```

用户像写普通 JavaScript 一样写多 agent 编排，同时 runtime 提供后台运行、状态查询、持久化 artifacts、模型可见完成通知、wait/resume/transcript/events/retry/worktree/prune/best-effort graph 等能力。

一句话：

> `pi-dynamic-workflows-bg` 是一个 artifact-backed、model-visible、可观测、可恢复、带 best-effort graph 的 JS workflow runtime，但仍然保持“像普通 JS 一样写 workflow”的核心体验。

---

## 2. 最重要的设计原则

### 2.1 好用优先

不要为了展示、恢复或 parity 让 workflow 变难写。

用户应该继续自然地写：

```js
if (needReview) {
  await agent('Review this module', { label: 'review' })
}

const results = await parallel([
  () => agent('Check correctness', { label: 'correctness' }),
  () => agent('Check tests', { label: 'tests' }),
])
```

不要强迫用户写：

```js
graph.branch()
graph.edge()
graph.skipped()
```

### 2.2 不复制 pi-subagents

`pi-subagents` 是生产级子代理执行系统，强在 fleet、intercom、supervisor、control channel、async revive 等。

workflow-bg 的核心价值是：

- JS workflow；
- 动态流程；
- fan-out / fan-in；
- pipeline；
- 普通代码控制流。

不要把 workflow-bg 做成第二套 `pi-subagents`。

### 2.3 Artifacts 是 source of truth

后台 run 的状态、结果、事件、child sessions 都必须落盘。内存 registry 可以丢，artifacts 不能丢。

---

## 3. 为什么要做这个 fork

原版 `pi-dynamic-workflows` 的优势是轻量、自然、好写，但它主要是前台阻塞式 prototype：

- 没有后台 run id；
- 没有 durable artifacts；
- 没有 status/result/wait；
- 没有 events；
- 没有 transcript；
- 没有 resume；
- 没有 model-visible background completion；
- 长任务或复杂任务不够生产可用。

本 fork 的目标是：

> 保留原版 JS workflow DSL，同时补齐后台运行时所需的生产能力。

---

## 4. 用户入口

### 4.1 工具名保持不变

仍然是：

```text
workflow
```

但默认行为变为后台运行。若要原版前台阻塞行为：

```json
{ "foreground": true }
```

### 4.2 模型工具

当前注册：

```text
workflow
workflow_status
workflow_result
workflow_summary
workflow_transcript
workflow_events
workflow_worktrees
workflow_worktree_cleanup
workflow_prune
workflow_steer
workflow_resume
workflow_cancel
workflow_wait
```

### 4.3 Slash commands

```text
/workflow-status [id-prefix] [--limit N]
/workflow-result <id-prefix>
/workflow-summary <id-prefix>
/workflow-events <id-prefix>
/workflow-transcript <id-prefix> [agent-label-or-index]
/workflow-worktrees [id-prefix]
/workflow-worktree-cleanup [id-prefix]
/workflow-prune [--delete] [--older-than-days N] [--keep-last N]
/workflow-steer <id-prefix> -- <steering prompt>
/workflow-resume <id-prefix> -- <follow-up prompt>
/workflow-cancel <id-prefix>
```

---

## 5. 项目文件结构

```text
.
├── extensions/
│   └── workflow.ts              # Pi extension 入口：工具、命令、通知、provider compat
├── src/
│   ├── workflow.ts              # JS workflow runtime：parse、vm、agent/parallel/pipeline
│   ├── workflow-tool.ts         # workflow tool facade：前台/后台路径
│   ├── background.ts            # 后台 manager：lifecycle、artifacts、restore、wait、resume、prune
│   ├── agent.ts                 # child agent wrapper：createAgentSession、resume
│   ├── display.ts               # snapshot、render、best-effort graph
│   ├── tool-budget.ts           # tool budget wrapper
│   ├── structured-output.ts     # structured output tool
│   └── index.ts                 # package exports
├── types/
│   └── workflow.d.ts            # workflow script ambient globals 类型提示
├── docs/
│   ├── PIWEB_GRAPH_CONTRACT.md  # pi-web graph 合约与双方分工
│   └── workflow-bg/
│       ├── README_CN.md         # 本文：建设总结 + 接手指南
│       ├── PARITY.md            # 与 pi-subagents 的 parity 状态
│       └── UNSUPPORTED.md       # 明确 non-goals / partial 能力
├── qa-smoke.mjs
├── qa-tool-budget.mjs
├── qa-manager-comprehensive.mjs
├── qa-extension-smoke.mjs
├── package.json
└── .github/workflows/ci.yml
```

---

## 6. 核心能力

### 6.1 后台运行与模型可见完成

默认：

```text
workflow -> 后台运行 -> 立即返回 run id
```

完成后：

```ts
pi.sendMessage(..., { triggerTurn: true })
```

这样主模型能看到后台完成结果，而不是只有 UI 知道。

---

### 6.2 Artifacts

每个 run 写入：

```text
~/.pi/agent/background-workflows/runs/<run-id>/
├── status.json
├── events.jsonl
├── output.md
├── result.json
└── sessions/
```

说明：

- `status.json`：最新 run 状态和 snapshot；
- `events.jsonl`：生命周期事件；
- `output.md`：人类可读输出；
- `result.json`：workflow return value；
- `sessions/`：child agent session transcript。

关键 JSON/Markdown artifacts 使用 temp-file + atomic rename；失败时 best-effort 清理 tmp。

---

### 6.3 Durable registry / recovery

实现：

- 启动时 restore 历史 `status.json`；
- 查询时 lazy-load disk artifacts；
- stale `running` → `interrupted`；
- live owner process 不会被误中断；
- restored artifact paths 被约束在真实 artifact dir；
- malformed `status.json` 被忽略；
- `restore:false` manager 不 hydrate disk runs。

---

### 6.4 wait/status/result/summary/events/transcript

已实现：

- `workflow_status`：列表/单 run 状态；列表默认最近 50 条，带状态计数；
- `workflow_result`：当前/最终结果；
- `workflow_summary`：一页诊断；
- `workflow_events`：读 `events.jsonl`；
- `workflow_transcript`：读 child session；
- `workflow_wait`：等单个 run，或 `all:true` 等当前 session idle。

session identity 使用：

```ts
getSessionFile() ?? getSessionId()
```

避免 start/wait/drain session scope 不一致。

---

### 6.5 retry/fallback/model

`agent()` 支持：

```js
agent('...', {
  model: 'provider/model-id',
  fallbackModels: ['provider/fallback-model'],
  retry: 2,
  retryDelayMs: 1000,
})
```

行为：

- retryable provider/model error 默认 retry 1 次；
- fallbackModels 按顺序尝试；
- non-retryable error 不 fallback；
- attempts 写入 snapshot 和 events。

---

### 6.6 budget/timeout

支持：

```js
agent('...', {
  timeoutMs: 120000,
  toolBudget: { soft: 20, hard: 30, block: '*' },
  turnBudget: { maxTurns: 4, graceTurns: 1 },
})
```

包括：

- workflow-level `tokenBudget`；
- per-child timeout；
- tool soft warning；
- hard tool blocking；
- turn budget prompt guidance + post-run enforcement。

---

### 6.7 worktree

支持：

```js
agent('...', { isolation: 'worktree' })
```

能力：

- 创建 detached git worktree；
- child 在 worktree cwd 运行；
- snapshot/events 记录 worktreePath；
- `workflow_worktrees` 查询；
- `workflow_worktree_cleanup` 清理；
- 默认拒绝 dirty worktree；
- `force:true` 才强删。

---

### 6.8 resume/steer

支持：

```text
workflow_resume
workflow_steer
```

边界：

- `workflow_resume` 只是继续 child session，不恢复 JS workflow graph；
- `workflow_steer` 是 current-process live child best-effort；
- 没有 ack/recovery/supervisor 协议。

---

### 6.9 prune

新增：

```text
workflow_prune
/workflow-prune
```

默认 dry-run：

```json
{ "dryRun": true }
```

支持：

```json
{
  "keepLast": 100,
  "olderThanDays": 14,
  "dryRun": false
}
```

安全约束：

- 永不 prune running workflows；
- 默认只预览；
- 参数必须是非负有限数字；
- 需要显式 `--delete` / `dryRun:false` 才真正删除。

---

### 6.10 best-effort display graph

为 pi-web 提供：

```text
foreground details.graph
background status.json.snapshot.graph
```

定位：

> best-effort display graph，不是 full control-flow DAG。

已支持：

- stable agent node ids；
- phase/status；
- attempts；
- tool count；
- duration；
- sessionFile；
- worktreePath；
- simple seq edges；
- `parallel()` / `pipeline()` group nodes；
- nested group parentId；
- pipelineCell；
- cancelled graph terminal state。

不支持 / 不承诺：

- if/else skipped 自动上报；
- branchReason；
- data edge；
- business retry edge；
- loop total；
- full control-flow DAG；
- 用户 graph API；
- AST 插桩。

---

## 7. 技术方案关键点

### 7.1 `src/workflow.ts`

职责：

- parse script；
- 校验 `export const meta = ...`；
- 创建 VM context；
- 暴露 workflow globals；
- 实现 `agent()` / `parallel()` / `pipeline()`；
- 通过 callbacks 让 foreground/background 记录 snapshot。

重要实现：

- `agentRunId`：每次 agent 调用生成内部稳定 id，避免重复 label 串数据；
- `AsyncLocalStorage`：传递 graph parent context，避免并发串 parentId；
- safe VM context：禁 `Date`、`Math.random`、`Function`、`eval`、`globalThis`、timer、code generation。

### 7.2 `src/background.ts`

职责：后台 manager。它是最大文件，包含 lifecycle、restore、events、notification、wait、resume、steer、worktree、prune、formatters。

后续如果重构，优先考虑拆：

- artifact store / restore；
- notification batching；
- lifecycle runner；
- worktree service；
- transcript reader；
- formatters。

但不要在功能 bugfix 里大拆。

### 7.3 `src/display.ts`

职责：snapshot 与 graph 类型、文本渲染、graph helpers。

其中 `recomputeWorkflowSnapshot()` 会同步 counts 和 graph seq edges。

### 7.4 `src/workflow-tool.ts`

职责：`workflow` tool facade。

- 后台路径：`backgroundManager.start()`；
- 前台路径：直接 `runWorkflow()`；
- 前台 details 与后台 snapshot 同构；
- 支持测试/嵌入用 `agent` runner 注入，避免 QA 依赖真实模型 provider。

### 7.5 `extensions/workflow.ts`

职责：Pi extension adapter。

- 注册 tools；
- 注册 slash commands；
- 注册 model-visible message renderer；
- 注册 best-effort background-work provider；
- session_start 自动启用工具；
- headless agent_end drain 当前 session。

---

## 8. 与原版 workflow / pi-subagents 的差异

### 8.1 与原版 workflow

| 能力 | 原版 | workflow-bg |
|---|---|---|
| 默认执行 | 前台阻塞 | 后台运行 |
| run id | 无 | 有 |
| artifacts | 无 | 有 |
| status/result/wait | 无 | 有 |
| transcript | in-memory | 持久化 |
| retry/fallback | 无 | 有 |
| worktree | 无真实隔离 | 有 |
| graph | 无 | best-effort display graph |

### 8.2 与 pi-subagents

workflow-bg 是 JS workflow runtime。  
pi-subagents 是生产级子代理执行/控制平台。

| 场景 | 推荐 |
|---|---|
| 多阶段 JS workflow、动态流程、pipeline/fan-in | workflow-bg |
| 派 reviewer/worker/scout、fleet/intercom/supervisor | pi-subagents |
| 需要普通 JS 控制流 | workflow-bg |
| 需要完整 async control/revive/steer ack | pi-subagents |

---

## 9. 明确 non-goals / partial

详见：

```text
docs/workflow-bg/UNSUPPORTED.md
docs/workflow-bg/PARITY.md
```

主要包括：

- true JS workflow checkpoint/resume；
- full fleet TUI；
- supervisor/intercom；
- robust live steer ack/recovery；
- full child revive parity；
- advanced provider-specific fallback policy；
- worktree merge-back；
- full live budget state machine；
- canonical `subagent_wait` parity。

这些如果强做，会把 workflow-bg 变成第二个 `pi-subagents`，违背“简洁稳定”。

---

## 10. 验收标准与 QA

### 10.1 必跑命令

```bash
npm test
npm run check
npm pack --dry-run
```

含义：

- `npm test` = `npm run qa:full`；
- `npm run check` = TypeScript build gate；
- `npm pack --dry-run` = 验证分发内容。

### 10.2 CI

GitHub Actions：

```text
npm ci
npm run qa:full
npm pack --dry-run
```

### 10.3 QA 覆盖范围

`qa:full` 包括：

```text
qa-smoke.mjs
qa-tool-budget.mjs
qa-manager-comprehensive.mjs
qa-extension-smoke.mjs
```

覆盖：

- background happy path；
- foreground `details.graph`；
- model-visible completion；
- events/result/status/summary/transcript；
- wait single / wait all / wait timeout；
- cancel；
- retry/fallback；
- timeout；
- token/tool/turn budget；
- worktree；
- prune dry-run/delete/active-run protection/olderThanDays/invalid input；
- restore/lazy restore/malformed/restore:false；
- trusted artifact root；
- atomic write cleanup；
- session identity；
- duplicate label attribution；
- nested parallel/pipeline graph；
- cancelled graph terminal states；
- deterministic runtime hardening。

---

## 11. 踩过的坑

### 11.1 后台完成必须用 `triggerTurn:true`

否则模型看不到后台完成结果。

### 11.2 不要依赖 `subagent_wait`

provider compat 受 extension realm 影响。可靠入口是：

```text
workflow_wait
```

### 11.3 label 不是唯一 id

重复 label 会导致 attempts/session/worktree/graph 归因错。必须用内部 `agentRunId`。

### 11.4 parallel/pipeline parent 不能用全局变量

并发 thunk 会串。使用 `AsyncLocalStorage`。

### 11.5 cancel 后 graph 不能残留 running

group end 要放到 `finally`，终态要收敛。

### 11.6 deterministic guard 不能只靠 AST

要在 VM runtime 里真正禁掉随机、时间、动态 codegen。

### 11.7 restore 不能信任 status.json 里的路径

恢复路径必须以真实 artifact dir 为准。

### 11.8 prune 必须默认安全

删除类功能必须 dry-run 默认、拒绝 running、参数校验。

### 11.9 本地 test 必须和 CI 一致

避免 CI 绿、本地 `npm test` 红。

---

## 12. 后续接手开发流程

1. 先读：

```text
docs/workflow-bg/README_CN.md
docs/workflow-bg/PARITY.md
docs/workflow-bg/UNSUPPORTED.md
docs/PIWEB_GRAPH_CONTRACT.md
```

2. 查看状态：

```bash
git status --short
git log --oneline --max-count=10
```

3. 修改后跑：

```bash
npm test
npm run check
npm pack --dry-run
```

4. 推送后看 CI：

```bash
gh run list --repo O1SL/pi-dynamic-workflows-bg --limit 3
```

5. 更新本机 Pi：

```bash
pi update git:github.com/O1SL/pi-dynamic-workflows-bg
```

6. 如果改了工具定义，在 Pi 会话中：

```text
/reload
```

---

## 13. 后续可选优化

可以做：

- 抽 shared snapshot/graph recorder，减少 foreground/background duplication；
- child abort signal cleanup；
- slash command parse helper；
- 更多 real Pi E2E；
- pi-web 真实展示联调；
- 将部分纯 helper QA 迁移到 `node:test`。

谨慎做：

- 拆分 `src/background.ts`；
- table-driven extension tools；
- 更完整 model fallback policy；
- per-agent output artifact。

不建议做：

- full control-flow DAG；
- AST 插桩；
- 强制 graph API；
- 自动推断业务 data edge；
- true JS VM checkpoint/resume；
- 完整复制 `pi-subagents`。

---

## 14. 当前状态总结

当前项目已经具备稳定后台 workflow runtime 的主要能力：

- 好写：普通 JS workflow；
- 好跑：默认后台，支持 foreground 兼容；
- 好查：status/result/summary/events/transcript；
- 好恢复：artifacts/recovery/lazy restore/interrupted；
- 好扩展：retry/fallback/budget/worktree/prune/graph；
- 好维护：QA/CI/pack/docs 同步；
- 边界清楚：不复制 `pi-subagents`，只补 workflow runtime 该有的能力。

最重要的原则仍然是：

> 保持 workflow 好写、好用、稳定。不要为了展示或 parity 牺牲这个核心体验。
