# best-effort display graph —— pi-web 展示用执行图（v2 · 收敛版）

> 给正在开发 `pi-dynamic-workflows-bg` 的同学/agent。本文自带背景，不需要预先了解 pi-web。
>
> **v2 修订说明**：v1 版把需求写大了，暗示要上报"没走的分支/数据流/分支原因"，你们据此担心会逼用户写
> `graph.branch()` / `graph.edge()` 这类标注 API——**这个担心是对的，也是 v1 文档表述不清造成的**。
> v2 已按你们的反馈收敛：**撤销所有需要静态分析或用户标注的字段**，只保留运行时本来就在手上的数据。
> 定位改为你们提的说法：**best-effort display graph，不是 full control-flow DAG**。

---

## 结论：workflow-bg 侧接受 v2 方向，但按轻量分阶段实现

workflow-bg 侧认可这版 v2 的收敛方向：这是一个 **best-effort display graph**，不是 full control-flow DAG。实现边界应保持清晰：

1. **不改变用户写 workflow 的方式**。用户仍然自然地写普通 JS、`agent()`、`parallel()`、`pipeline()`、`phase()`；不要求为了展示新增 `graph.branch()` / `graph.edge()` / `graph.skipped()` 之类 API。
2. **第一阶段只输出运行时已经确定知道的数据**：agent 节点、phase、status、attempts、tool count、sessionFile、worktreePath，以及简单 `seq` 边。
3. **不承诺完整控制流语义**：不由 workflow-bg 自动上报没走过的 if/else 分支、branchReason、业务 data edge、业务 retry 回边、loop 总轮数等。这些要么需要 JS 静态分析/插桩，要么需要用户标注，不应进入 workflow-bg 默认写法。
4. **`parallel()` / `pipeline()` 分组可以作为第二阶段增强**。它们是 workflow-bg 自己的 API，原则上比 if/for 更可控；但实现 parent/child 归属时要处理并发上下文，不是零成本，所以不建议作为第一阶段硬门槛。
5. **pi-web 需要按渐进增强消费**：没有 `graph` 或 graph 字段不完整时继续 fallback；有基础 nodes 就画基础图；未来如果有分组/边/usage 再逐步增强。

当前实现状态（workflow-bg）：**Phase 1 + Phase 2 已实现**。

已实现内容：`snapshot.graph`、agent nodes、phase/status、attempts、tool count、duration/session/worktree metadata、best-effort `seq` edges，以及 `parallel()` / `pipeline()` group nodes with `parentId` / `pipelineCell`。仍然不实现 skipped branch、data edge、branchReason、AST 插桩或用户 graph API。

推荐实施顺序：

- **Phase 1：基础自动 graph**
  - `snapshot.graph`
  - agent nodes
  - phase/status
  - attempts/tool count/session/worktree metadata
  - best-effort seq edges
  - 前台 `details.graph` 与后台 `status.json.snapshot.graph` 同构

- **Phase 2：可选 parallel/pipeline 分组**
  - `kind: "parallel" | "pipeline"`
  - `parentId`
  - pipeline cell 信息
  - 需要谨慎处理并发上下文，避免为了展示引入不稳定 runtime 行为

- **暂不做 / 非目标**
  - 完整 DAG
  - if/else skipped 自动上报
  - data edge 自动推断
  - branchReason
  - graph API 强制标注
  - AST 插桩式控制流跟踪

一句话：**可以做轻量 graph，但不能让展示需求反过来增加 workflow 作者的心智负担。workflow-bg 的核心价值仍然是好写、好跑、稳定。**

---

## 〇、先对齐一个前提（重要）

**我们从来不需要用户为了展示多写一个字。** 需求的对象是**运行时**，不是 workflow 作者。

workflow 该长什么样就长什么样：

```js
if (rust.length) await agent('...', { label: 'Rust分支评估' })
for (const p of projects) await agent('...', { label: `循环-${p.name}` })
await parallel([...])
```

上面这段代码**一个字都不用改**。我们只是问：**这些 agent 跑起来的时候，运行时能不能顺手把"谁、属于哪个阶段、什么状态、花了多少"这些它已经知道的事写进 `graph`。**

你们提的原则——「workflow-bg 的第一优先级是好用、自然、稳定；不要为了前端展示让 workflow 写法变复杂」——**我们完全同意，并把它作为本文档的约束条件。**

---

## 一、背景：谁在用、用来干什么

**pi-web** 是 pi 的网页版界面（本机 `~/dev/pi-web`，日常跑在 `localhost:30141`）。用户在网页里跟 pi 对话，pi 调用你们的 `workflow` 工具跑多 agent 编排。

pi-web 会把每次运行渲染成一张可视化卡片，数据来自 `details`（前台）/ `status.json` 的 `snapshot`（后台）。现在已经能显示：名称、阶段、每个 agent 的状态、进度、耗时，并且能实时刷新。

**现在的短板**：卡片是一条直线（阶段 1 → 2 → 3）。用户写了 13 个 agent 的复杂编排时，看到的是一条 13 个节点的长龙，看不出"这 3 个是并行的""这 3 个是一条流水线"。

---

## 二、明确撤销的需求（v1 有、v2 没有）

以下字段**不再要求**，理由就是你们说的——它们要么需要 JS 静态分析，要么需要用户标注，代价与收益不成正比：

| 撤销项 | 撤销理由（认同你们的判断） |
|---|---|
| `status: "skipped"` | 运行时只看得见"跑过的 agent"，**根本不知道有个 if 分支没跑**。要知道必须静态分析脚本。**这个我们自己在 pi-web 侧做。** |
| `edges[].kind = "data"` | 需要追踪 JS 变量依赖（`topProject → pipeline`），只能靠 AST 插桩。撤销。 |
| `branchReason` | 同上，需要求值条件表达式。撤销。 |
| `kind: "branch"` / `kind: "loop"` 分组 | `if`/`for` 是裸 JS，运行时无从感知。**这两个我们自己在 pi-web 侧从脚本文本推断。** |
| "完整控制流 DAG"作为默认目标 | 同意不作为默认。 |
| 任何形式的 `graph.*()` 用户 API | **从来不需要，是 v1 表述造成的误解。** |

---

## 三、想请你们重新评估的一点：`parallel()` / `pipeline()` 是零成本的

这是 v2 唯一想"加回来"的东西，理由是**它和 `if`/`for` 的性质完全不同**：

- `if` / `for` 是**裸 JS 语法** → 运行时确实看不见，我们不要求；
- `parallel([...])` / `pipeline(items, s1, s2)` 是**你们自己的 API** → 运行时执行到那一刻，"这几个是一组、并行/流水线"这个事实**就在函数参数里**，不需要任何静态分析、不需要用户多写一个字。

```js
await parallel([a, b, c])          // ← 运行时此刻明确知道：这 3 个是一组，并行
await pipeline(items, s1, s2, s3)  // ← 明确知道：m 个 item × n 个 stage
```

**为什么这个收益特别大**：复杂编排里信息量最高的就是"哪些是并发的"。有了分组，13 个节点的长龙会变成「1 → ⎔3 → 1 → ⇉3 → 1」这种一眼看懂的结构；没有分组，就还是一条长龙。

具体做法：执行 `parallel`/`pipeline` 时多产出一个 group node，成员通过 `parentId` 指向它（或用嵌套 `children`，见 §5）。**如果这一条实现成本超出预期，砍掉也行**，其余部分照样有价值。

---

## 四、最终请求（全部是运行时已有的数据）

在 `details` 里加 `graph` 字段，后台模式同样写进 `status.json` 的 `snapshot.graph`，随进度更新。

```jsonc
"graph": {
  "runId": "20260725111800-xxx",
  "nodes": [
    {
      // ── 必填 ──
      "id": "a1",              // 稳定唯一，实时刷新靠它对齐，运行期间不可变
      "label": "发现",          // 就是 agent() 的 label
      "status": "done",        // pending | running | done | error
      "kind": "agent",         // agent | parallel | pipeline

      // ── 有就给，没有就算 ──
      "phase": "配置与发现",     // 当前 phase()
      "parentId": "g1",        // 属于哪个 parallel/pipeline 组
      "usage": { "tokens": 39000, "toolCount": 12, "durationMs": 41000, "model": "gpt-5.5" },
      "attempts": [            // retry / fallbackModels 的每次尝试
        { "model": "gpt-5.5", "status": "failed", "error": "429 ..." },
        { "model": "claude-sonnet-4", "status": "succeeded" }
      ],
      "artifactPath": "/abs/path/output.md",
      "sessionFile": "/abs/path/session.jsonl",
      "worktreePath": "/abs/path/worktree"
    }
  ],
  "edges": [
    { "from": "a1", "to": "a2", "kind": "seq" }   // 只要 seq；执行先后顺序
  ]
}
```

就这些。对照你们 §5 提的实施边界 —— **完全一致**：

> snapshot.graph / agent node 自动派生 / phase 信息 / 简单 seq edge / attempts、tool count、session、worktree metadata / 前台后台一致

唯一补充是 §3 说的 `parallel`/`pipeline` 分组（可选）。

---

## 五、两种形状都行，选你们顺手的

同机的 `pi-subagents` 用**嵌套 `children`** 表达从属：

```jsonc
{ "id": "s1", "kind": "parallel-group", "children": [ { "id": "s1a0", ... } ] }
```

我们用**扁平 `parentId`**：

```jsonc
{ "id": "g1", "kind": "parallel" }, { "id": "n1", "parentId": "g1" }
```

**pi-web 两种都已经支持**（`lib/workflow-graph.ts` 里都做了解析和单测），你们选实现起来顺手的即可。字段命名如果和内部结构冲突，也以你们方便为准，告诉我们改解析就行。

---

## 六、分工：谁负责哪一半

| 谁 | 负责 | 怎么做 |
|---|---|---|
| **workflow-bg 运行时** | agent 节点、`phase`、`seq` 边、`parallel`/`pipeline` 分组、status、usage、attempts、artifact/session/worktree | 都是执行时已在手的数据 |
| **pi-web** | `if/else` 分支识别、`for/while` 循环识别、动态 label 归并 | 静态扫描脚本的 `if`/`for` 块 —— **已经实现并上线了**，卡片上已经能显示 `⎇ 择一执行` / `↻ 循环` |

**你们给"确定知道的"，我们推断"只能猜的"。** 谁都不做自己不该做的事。

---

## 七、pi-web 侧的承诺

1. **渐进增强，完全按你们 §3 说的来**（这部分代码已经写完、134 个单测通过）：

   | 你们给到什么 | pi-web 显示什么 |
   |---|---|
   | 没有 `graph` | 现在的线性视图，**零影响** |
   | 只有 agent nodes | 基础流程图 |
   | + `phase` | 按 phase 分列 |
   | + `parallel`/`pipeline` 分组 | 画成分组框，标 `∥ 并行` / `⇉ 流水线` |
   | + `seq` edges | 真正按依赖排布 |
   | + `usage`/`attempts` | 节点上显示 tokens / 工具数 / 耗时 / 重试链 |

2. **绝不因为字段缺失而空白或报错**：`graph` 缺失、`edges` 缺失、`usage` 缺失，各自独立降级。

3. **不要求一次做完**：先上 nodes + phase 就有价值，`seq` 边和分组后面再加，pi-web 会自动识别并升级显示。

---

## 八、唯一的硬性要求

只有一条：**`id` 在整个运行期间必须稳定**。pi-web 靠它做增量更新，`id` 变了节点会闪烁/重排。其余字段全部可选、可后补。

---

## 九、参考

- 视觉稿（浏览器直接打开）：`~/Desktop/AI项目/Pi/knowledge/02-workflow-dag-view.v1.html`
  （注：该稿是 v1 时期画的"完整 DAG"效果，其中的**数据流虚线、回边、灰色划掉的未走分支**按 v2 共识已不再要求，看结构布局即可）
- pi-web 侧消费代码：
  - `lib/workflow-graph.ts` —— graph 解析 + 自动布局（含 11 个单测）
  - `components/WorkflowDagView.tsx` —— 图渲染
  - `lib/workflow-run.ts` / `lib/subagent-run.ts` —— 现有 details 解析
  - `app/api/workflows/[id]/route.ts` —— 后台 status.json 读取
