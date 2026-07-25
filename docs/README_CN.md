# pi-dynamic-workflows-bg 建设总结

本文总结 `pi-dynamic-workflows-bg` 从原版 `pi-dynamic-workflows` fork 到当前后台工作流运行时的建设过程、设计取舍、能力边界、验证方式和后续维护建议。

仓库：<https://github.com/O1SL/pi-dynamic-workflows-bg>  
本地路径：`/Users/bytedance/Desktop/AI项目/Pi/pi-dynamic-workflows-bg`  
Pi 安装源：`git:github.com/O1SL/pi-dynamic-workflows-bg`

---

## 1. 项目目标

原版 `pi-dynamic-workflows` 的核心价值是：

- 用普通 JavaScript 写 workflow；
- 支持 `agent()`、`parallel()`、`pipeline()`、`phase()`；
- 适合多 agent 编排和 fan-out/fan-in；
- 写法自然，不需要用户学习复杂 DSL。

但原版主要是前台阻塞式 prototype：

- workflow 在一次 tool call 内执行完；
- 没有后台 run id；
- 没有状态查询；
- 没有 durable artifacts；
- 没有完成后唤醒模型；
- 没有 transcript / resume / wait / events；
- 对长任务和复杂任务不够生产可用。

本 fork 的目标是：

> 在保留原版“普通 JS workflow 好写、自然”的前提下，把它建设成更接近 `pi-subagents` 成熟度的后台 workflow runtime。

注意：目标不是复制 `pi-subagents`，也不是把 workflow 变成第二套 subagent runtime。最终取舍原则是：

> **workflow-bg 的第一优先级是好用、自然、稳定；不要为了展示、恢复或 parity 让 workflow 写法变复杂。**

---

## 2. 当前安装与入口

当前 Pi 已安装新版：

```text
git:github.com/O1SL/pi-dynamic-workflows-bg
```

原版 `npm:pi-dynamic-workflows` 已不在当前 Pi 安装列表中。

新版保留原有工具名：

```text
workflow
```

也就是说旧的调用入口还在，但默认行为变了：

| 行为 | 原版 | 新版 workflow-bg |
|---|---|---|
| 默认执行 | 前台阻塞 | 后台运行 |
| 返回 | tool result | run id + artifact 路径 |
| 完成通知 | 当前 tool result | 模型可见后台消息 |
| 前台兼容 | 默认 | `foreground:true` |

如果希望使用原版前台阻塞行为：

```json
{
  "foreground": true
}
```

---

## 3. 核心设计原则

### 3.1 保持普通 JS 写法

用户仍然写普通 workflow：

```js
export const meta = {
  name: 'repo_audit',
  description: 'Audit repository from multiple angles',
}

phase('Discover')
const inventory = await agent('Inspect repository structure', {
  label: 'repo inventory',
})

phase('Review')
const reviews = await parallel([
  () => agent('Review correctness:\n' + inventory, { label: 'correctness' }),
  () => agent('Review tests:\n' + inventory, { label: 'tests' }),
])

phase('Synthesis')
const summary = await agent('Synthesize findings:\n' + JSON.stringify(reviews), {
  label: 'synthesis',
})

return { inventory, reviews, summary }
```

没有强制 graph API，没有强制分支标注，没有要求为了前端展示多写样板代码。

### 3.2 后台化，但不牺牲可控性

新版默认后台运行，立即返回 run id：

```text
Started background workflow repo_audit.
Run ID: 20260725123000-repo-audit
Artifacts: ~/.pi/agent/background-workflows/runs/20260725123000-repo-audit
```

完成后通过：

```ts
pi.sendMessage(..., { triggerTurn: true })
```

发送模型可见通知，让主模型能继续消费结果。

### 3.3 Artifacts 是 source of truth

运行时状态和结果都落盘：

```text
~/.pi/agent/background-workflows/runs/<run-id>/
├── status.json
├── events.jsonl
├── output.md
├── result.json
└── sessions/
```

其中：

- `status.json`：run 元数据和最新 snapshot；
- `events.jsonl`：生命周期事件；
- `output.md`：人类可读结果；
- `result.json`：workflow return value；
- `sessions/`：child agent session transcript。

---

## 4. 已建设能力总览

### 4.1 后台运行与完成通知

实现：

- `workflow` 默认后台；
- `foreground:true` 前台兼容；
- 完成后模型可见通知；
- 通知 batching / dedupe；
- 大结果截断，完整结果留在 artifacts。

相关文件：

```text
src/workflow-tool.ts
src/background.ts
extensions/workflow.ts
```

---

### 4.2 管理工具

当前注册工具：

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

对应 slash commands：

```text
/workflow-status
/workflow-result
/workflow-summary
/workflow-transcript
/workflow-events
/workflow-worktrees
/workflow-worktree-cleanup
/workflow-prune
/workflow-steer
/workflow-resume
/workflow-cancel
```

其中：

- `workflow_status` 默认列最近 50 条，并显示状态计数；
- ambiguous prefix 会列候选 run id；
- cancel/wait 复用统一 lookup diagnostics；
- `workflow_wait` 支持单 run，也支持 `all:true` 等当前 session idle。

---

### 4.3 Durable registry / recovery

实现：

- 启动时 restore 历史 `status.json`；
- 查询时 lazy-load disk artifacts；
- stale `running` 变成 `interrupted`；
- `ownerPid` + process liveness 避免误中断 live owner；
- restored artifact paths 被约束在真实 artifact directory 内；
- malformed `status.json` 被忽略，不影响 manager。

相关文件：

```text
src/background.ts
```

---

### 4.4 Events / Summary / Transcript

实现：

- `events.jsonl` 记录 workflow lifecycle；
- `workflow_events` 读取事件；
- `workflow_summary` 输出一页诊断；
- child sessions 持久化到 run artifact 目录；
- `workflow_transcript` 可按 agent selector 读取 transcript；
- transcript 路径必须在 artifact root 内，避免读取外部路径。

---

### 4.5 Retry / fallback / model selection

`agent()` 支持：

```js
agent('...', {
  model: 'provider/model-id',
  fallbackModels: ['provider/fallback-model'],
  retry: 2,
  retryDelayMs: 1000,
})
```

语义：

- retryable provider/model error 默认 retry 1 次；
- `fallbackModels` 在 primary model 失败后尝试；
- non-retryable error 不 fallback；
- 每次 attempt 写入 snapshot 和 `events.jsonl`。

---

### 4.6 Budget / timeout

支持：

```js
agent('...', {
  timeoutMs: 120000,
  toolBudget: { soft: 20, hard: 30, block: '*' },
  turnBudget: { maxTurns: 4, graceTurns: 1 },
})
```

能力包括：

- workflow-level `tokenBudget`；
- per-child `timeoutMs`；
- tool soft warning；
- hard tool blocking；
- turn budget prompt guidance + post-run enforcement。

---

### 4.7 Worktree isolation

支持：

```js
agent('...', {
  isolation: 'worktree',
})
```

实现：

- 创建 detached git worktree；
- child agent 在 worktree cwd 里运行；
- snapshot/events 记录 worktreePath；
- `workflow_worktrees` 查询；
- `workflow_worktree_cleanup` 清理；
- 默认拒绝 dirty worktree，`force:true` 才强删。

---

### 4.8 Resume / steer

支持：

```text
workflow_resume
workflow_steer
```

边界：

- `workflow_resume` 是 child session continuation，不恢复 JS workflow graph；
- `workflow_steer` 是 current-process live child best-effort；
- 无 delivery ack / recovery / supervisor 协议。

这些边界在 `docs/UNSUPPORTED.md` 里明确记录。

---

### 4.9 Safe artifact pruning

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

安全原则：

- 永不 prune running workflows；
- 默认只预览；
- 参数必须是非负有限数字；
- 删除 terminal artifact dir 后更新内存 registry。

---

### 4.10 Best-effort display graph

为 pi-web 增加展示图：

```text
foreground details.graph
background status.json.snapshot.graph
```

定位：

> best-effort display graph，不是 full control-flow DAG。

当前自动上报：

- agent nodes；
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
- pipelineCell。

明确不做：

- if/else skipped 自动上报；
- data edge；
- branchReason；
- AST 插桩；
- 用户 graph API。

这样满足前端展示增强，同时不增加 workflow 作者负担。

---

## 5. 与原版 workflow 的区别

| 能力 | 原版 `pi-dynamic-workflows` | 当前 `pi-dynamic-workflows-bg` |
|---|---|---|
| 默认执行 | 前台阻塞 | 后台运行 |
| 前台兼容 | 默认 | `foreground:true` |
| 完成通知 | tool result | `sendMessage(... triggerTurn:true)` |
| run id | 无 | 有 |
| status/result/wait | 无 | 有 |
| artifacts | 无 | 有 |
| events | 无 | 有 |
| transcript | in-memory | 持久化 |
| retry/fallback | 无 | 有 |
| per-child model | 基本只是 prompt guidance | 真实传入 child session |
| timeout/budget | 很弱 | workflow/child/tool/turn 多层 |
| worktree | 无真实隔离 | 有 detached worktree |
| recovery | 无 | restore/lazy-load/interrupted |
| prune | 无 | 有 |
| display graph | 无 | best-effort graph |

---

## 6. 与 pi-subagents 的关系

`pi-subagents` 仍然是更完整的子代理执行平台，具备：

- fleet TUI；
- supervisor/intercom；
- async control channel；
- steer ack/recovery；
- revive/recovery descriptor；
- nested run tree；
- 更完整的 model fallback policy；
- worktree branch/diff/merge 体系。

workflow-bg 不试图完全复制这些，而是在 workflow DSL 内提供足够成熟的后台能力。

最终定位：

| 系统 | 定位 |
|---|---|
| `pi-dynamic-workflows-bg` | 可编程 JS workflow runtime，适合多阶段编排、fan-out/fan-in、动态流程 |
| `pi-subagents` | 生产级子代理执行系统，适合派 reviewer/worker/scout、长任务控制、fleet/intercom/recovery |

两者互补，不互相替代。

---

## 7. 明确保留为 non-goals / partial 的能力

记录在：

```text
docs/UNSUPPORTED.md
docs/PARITY.md
```

包括：

- true JS workflow graph checkpoint/resume；
- full `pi-subagents` fleet TUI；
- supervisor/intercom protocol；
- robust live steer ack/recovery；
- full child session revive parity；
- advanced provider-specific fallback policy；
- automatic worktree merge-back；
- full live budget state machine；
- canonical `subagent_wait` parity。

理由：这些会把 workflow-bg 变成第二套 `pi-subagents`，违背架构简洁目标。

---

## 8. QA / CI

### 本地验证

推荐：

```bash
npm test        # 等价于 npm run qa:full
npm run check   # TypeScript build gate
npm pack --dry-run
```

`qa:full` 运行：

```text
npm run build
node qa-smoke.mjs
node qa-tool-budget.mjs
node qa-manager-comprehensive.mjs
node qa-extension-smoke.mjs
```

覆盖：

- background happy path；
- model-visible completion；
- status/result/summary/events/transcript；
- wait / wait all / wait timeout；
- cancel；
- retry/fallback；
- timeout；
- token/tool/turn budget；
- worktree；
- prune；
- restore / lazy restore / malformed restore / restore:false；
- trusted artifact root；
- atomic write cleanup；
- session identity；
- duplicate label attribution；
- nested graph groups；
- deterministic runtime hardening；
- foreground `details.graph`；
- background `status.json.snapshot.graph`。

### CI

GitHub Actions：

```text
npm ci
npm run qa:full
npm pack --dry-run
```

配置：

```text
.github/workflows/ci.yml
```

---

## 9. 安装与更新

安装：

```bash
pi install git:github.com/O1SL/pi-dynamic-workflows-bg
```

更新：

```bash
pi update git:github.com/O1SL/pi-dynamic-workflows-bg
```

更新后建议在 Pi 中执行：

```text
/reload
```

---

## 10. 维护建议

### 应优先保持的原则

1. 不增加 workflow 作者心智负担；
2. 不为了展示引入复杂用户 API；
3. artifacts 继续作为 source of truth；
4. 新管理能力默认安全，比如 dry-run、显式 force、拒绝 dirty；
5. 本地 `npm test` 和 CI 保持一致；
6. 大型结构重构要和功能 bugfix 分开。

### 后续可选优化

这些可以以后单独做：

- 抽 shared snapshot/graph recorder，减少 foreground/background callback duplication；
- 适度拆分 `src/background.ts`；
- 统一 slash command 参数解析 helper；
- child abort signal cleanup；
- 更多 real Pi E2E；
- pi-web 真实展示联调。

暂时不建议做：

- 完整 DAG；
- AST 插桩；
- 强制用户写 graph API；
- 自动推断业务 data edge；
- 自动 merge-back worktree。

---

## 11. 当前最新状态

当前版本已经具备稳定后台 workflow runtime 的基本生产能力：

- 好写：仍然是普通 JS workflow；
- 好跑：默认后台，支持 wait/status/result；
- 好查：artifacts/events/transcript/summary/graph；
- 好恢复：restore/lazy-load/interrupted；
- 好维护：QA/CI/pack/docs 同步；
- 边界清楚：不复制 `pi-subagents`，只补 workflow runtime 需要的能力。

一句话总结：

> `pi-dynamic-workflows-bg` 现在是一个 background-first、artifact-backed、model-visible、可观测、可恢复、带 best-effort graph 的 JS workflow runtime，同时仍然保留“像普通 JS 一样写 workflow”的核心体验。
