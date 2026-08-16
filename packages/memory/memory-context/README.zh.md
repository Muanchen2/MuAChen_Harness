# @deepseek-ai/dsh-memory-context

[English](README.md) | 中文

Rin 记忆上下文注入：祖先链的记忆搭载在第一轮。

## 这是什么

Rin 记忆系统的读侧自动化半边。`memory` 工具（`@deepseek-ai/dsh-tool-memory`）是写/维护入口，而本插件把工作区**祖先链**上每个已存在 store——目录树本身：任意层级都可携带自己的 `.dsh-memory`，子目录继承所有祖先的记忆——连同 central（全局）store 一起，渲染成一份**目录**（标题与 id）并折叠进**第一轮**的模型请求。agent 随后通过 `memory` 工具按需读取相关内容，而不是收到每条记忆正文——无需要求 agent 主动调用 `memory` 工具才知道有什么。

后续轮次不重复注入：第一轮上下文留在会话历史中，每轮重新注入会浪费上下文预算。从第二轮起由**自动联想**接管：每次请求检索最相关的 top-N 条已存记忆并注入其摘要，让 agent 像人一样带着相关经验推理——无需被要求。查询词按优先级构建：用户本次的直接用语优先，其次是最近推理块中的具体实体（session id、commit hash、报错码、文件路径——当前思考的实锤事实，绝不含推理的推测措辞），再以最近的执行上下文（最新工具结果与助手回复）补充。本会话已联想过的 id 不重复，交接单被排除（它们有自己的拾取通道），agent 可用 `memory read` 展开任何摘要。

第一轮内当 agent 通过 `memory` 工具写入记忆时，注入会在该轮内刷新，使刚记住的结论直达该轮下一步。

## 插件

注入 `memories`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | `8192` | 渲染上下文的最大字节数；超出预算的段落从尾部（最远层级优先）丢弃。 |
| `recallTopN` | `3` | 从第二轮起的自动联想：每次请求注入 top-N 条相关记忆摘要（`0` 关闭）。 |
| `recallCandidates` | `10` | 关键词粗筛上限：廉价关键词检索先保留 top-`recallCandidates` 条候选，再决定是否精排。 |
| `recallRerankTimeoutMs` | `15000` | 精排 LLM 调用的超时（仅在关键词检索超产时才花费）。 |
| `provider` / `model` | — | 精排调用的显式路由；缺省用会话最新 `request/header` 的路由。 |

## 设计

组合方式镜像 `@deepseek-ai/dsh-agent-instructions`：插件为每个 agent 在 inbox 中保留一条待定上下文消息，在 `agent/pre-step` 折叠进请求，并在 `memory` 工具成功 `remember` 的 `tools/result` 时重组。消息 source kind 为 `rin-memory`，因此注入的上下文与其他用户消息一样可从会话日志重建。

链从会话的 `header.cwd` 通过 `@deepseek-ai/dsh-memory` 的 `loadChain` 向上解析（只读已存在 store——链读取从不物化）；central store 永远不需要工作区。所有读取都由 git 支撑，因此在记忆规模下持久且廉价。

## 模型体验

### 请求上下文与条件

#### 模型看到的内容

当祖先链（或 central）任一 store 有记忆时，第一轮请求中出现一条用户角色目录消息——每个 store 一节，最近的在前，只列标题与 id。正文通过 `memory` 工具按需获取，因此 agent 选择相关项而不是接收全部：

##### 目录消息

```markdown
## Rin 记忆目录（workspace）

- [leaf] Leaf
- [bugfix/enoent] Fix ENOENT

## Rin 记忆目录（..）

- [parent] Parent

## Rin 记忆目录（central）

- [env/git-tool-path] Git 工具路径

需要详细内容时，用 memory read（scope 可选 workspace/chain/central）按 id 查询。
```

##### Store 标签

```markdown
The session's own store is labelled `workspace`; ancestor stores use their `..`-relative path from the session directory. Empty stores contribute nothing.
```

#### Token 影响

目录只列标题与 id（受 `maxBytes` 约束，默认 16384 字节——足以容纳数百条），外加一行获取提示。正文只在 agent 读取时付费。每会话一次（第一轮）；后续轮次通过会话历史保留目录而不是重新注入。

自动联想是两级的：廉价关键词检索（`searchChain`）先保留 top-`recallCandidates` 条候选，能装进 `recallTopN` 预算就直接注入（零 LLM 成本）。仅当关键词检索超产时，才调用一次辅助 LLM 做语义精排（输出 ≤128 token，受 `recallRerankTimeoutMs` 限制）；精排失败或超时回退关键词顺序，联想绝不会因模型而阻塞——辅助调用使用会话路由（显式 `provider`/`model` 或最新 `request/header`）。

#### KV Cache 影响

目录消息位于已认领提示与驱动追加的运行时上下文之间。底层记忆节点不变时其文本稳定；写入或编辑记忆节点会改变后续请求的载荷，在该位置断开前缀。联想注入随步骤与表面变化，永不共享稳定前缀。

## 已知限制与暂缓事项

- **目录按链全量，而非相关性排序** — 每一层列出最多 `maxBytes`；agent 自行选择读取内容。相关性排序与标签/权重模型推迟到 Rin 树模型。
- **逐步读取命中 git** — 每次 `agent/pre-step` 和刷新都通过 git 子进程调用读取 store 列表；在记忆规模下尚可，但 store 变大后应跟随投影缓存。
