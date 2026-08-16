# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

Rin 记忆服务之上的面向模型 `memory` 工具。

## 这是什么

通过 `memory` 工具让 agent 能够持久化并回顾跨会话的项目经验，与 `skill`（方法）相区分。适合在长任务开始时恢复既有结论，以及记录有意义的结论，使未来会话无需重复工作即可续接。

## 插件

注入 `tools`、`memories` 与 `systemPrompt`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sectionOrder` | `115` | 策略引导段在提示词中的顺序。 |

## 工具：`memory`

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `remember` / `read` / `list` / `timeline` |
| `scope` | string | `workspace`（会话目录的 store）、`central`（全局 store）或 `chain`（完整继承链：祖先目录沿线的每个 store 加 central，最近的在前；仅 read/list/timeline） |
| `id` | string | read/timeline 的节点 id，或 remember 保存到其下的 id。可以是 `/` 分隔的层级路径（`bugfix/enoent`）；省略时按标题自动生成 |
| `title` / `content` | string | remember 的标题/正文 |
| `message` | string | 可选的一行提交说明 |

workspace store 从调用会话的 `header.cwd` 解析；central store 永远不需要。`chain` 从会话目录的祖先向上走到 central store，因此子项目能看到每一层的共享记忆，最近的 store 在前。成功的 `remember` 会附带与新节点同目录的 id，使 agent 注意到已有同主题节点并更新它，而不是创建重复。

## 设计

该包是记忆能力 seam 的消费方角色；服务与语义位于 `@deepseek-ai/dsh-memory`。它渲染工具与一段策略引导，并分发到该服务。

## 模型体验

### 请求上下文与条件

#### 模型看到的内容

一个带 `remember/read/list/timeline` 动作的 `memory` 工具，以及一段解释技能/记忆区别的简短策略段。

##### 引导段逐字文本

```markdown
使用 memory 工具持久化与回顾跨会话的项目经验，区别于 skills（方法）：skills 存"怎么做"，memory 存"发生了什么、结论、当前状态"。记忆存储在 git 底座的 Rin 仓库：workspace 作用域存于当前项目旁，central 作用域跨项目共享；每个会话的第一轮会自动注入相关记忆，因此现在记录的经验在未来会话中自动可见。开始长任务前，先用 memory list/read 回顾相关记忆，恢复之前的结论与状态。写入前先查重：用 memory list 查看是否已有同主题记忆；有则用相同 id 更新（保留演进历史），避免同主题散成多条互相矛盾的记忆。在达成有意义的结论后立即 remember：修好了一个 bug、做出了架构决策、解决了一个坑、学到了环境或工具路径、或者改变了立场。记忆保持事实性与简洁；可复用的方法存入 skills，经验存入 memory。
```

#### Token 影响

固定工具 schema 和一段固定（小）策略段，每次请求付费。

#### KV Cache 影响

工具定义与引导段不变时前缀稳定。

## 已知限制与暂缓事项

- **重复检测按目录作用域，而非语义** — `remember` 只提示同目录 id；真正互相矛盾但 id/目录不同的节点由 agent 自己的审计发现，而非工具。
- **暂无分支操作** — git 分支支撑 store，但 `branch/checkout/merge` 未通过工具暴露；逐节点时间线通过 `memory timeline` 可用。
