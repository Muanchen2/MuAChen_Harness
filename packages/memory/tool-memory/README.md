# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing `memory` tool over the Rin memory service.

## What this is

Gives the agent a way to persist and recall cross-session project experience through a `memory` tool, distinct from `skill` (methods). Useful for restoring prior conclusions at the start of a long task and recording meaningful ones so a future session resumes without repeating work.

## Plugin

Injects `tools`, `memories`, and `systemPrompt`.

### Config

| Field | Default | Meaning |
|---|---|---|
| `sectionOrder` | `115` | Order of the policy guidance section. |

## Tool: `memory`

| Arg | Type | Notes |
|---|---|---|
| `action` | string | `remember` / `read` / `list` / `timeline` |
| `scope` | string | `workspace` (session dir's store), `central` (global store), or `chain` (the complete inheritance chain: every store along the ancestor directories plus central, nearest first; read/list/timeline only) |
| `id` | string | Node id for read/timeline, or the id to save under for remember. May be a `/`-separated hierarchy path (`bugfix/enoent`); auto-generated from the title when omitted |
| `title` / `content` | string | Heading/body for remember |
| `message` | string | Optional one-line commit note for this change |

The workspace store resolves from the calling session's `header.cwd`; the central store never needs one. `chain` walks the session directory's ancestors and ends at the central store, so a subproject sees every level's shared memories, nearest store first. A successful `remember` appends the ids sharing the new node's directory, so the agent notices an existing same-topic node and updates it instead of creating a duplicate.

## Design

This package is the consumer role of the memory capability seam; the service and semantics live in `@deepseek-ai/dsh-memory`. It renders the tool and a policy guidance section, and dispatches to that service.

## Model Experience

### Request context and condition

#### What the model sees

A `memory` tool with `remember/read/list/timeline` actions and a short policy section explaining the skill/memory distinction.

##### Verbatim text for the guidance section

```markdown
使用 memory 工具持久化与回顾跨会话的项目经验，区别于 skills（方法）：skills 存"怎么做"，memory 存"发生了什么、结论、当前状态"。记忆存储在 git 底座的 Rin 仓库：workspace 作用域存于当前项目旁，central 作用域跨项目共享；每个会话的第一轮会自动注入相关记忆，因此现在记录的经验在未来会话中自动可见。开始长任务前，先用 memory list/read 回顾相关记忆，恢复之前的结论与状态。写入前先查重：用 memory list 查看是否已有同主题记忆；有则用相同 id 更新（保留演进历史），避免同主题散成多条互相矛盾的记忆。在达成有意义的结论后立即 remember：修好了一个 bug、做出了架构决策、解决了一个坑、学到了环境或工具路径、或者改变了立场。记忆保持事实性与简洁；可复用的方法存入 skills，经验存入 memory。
```

#### Token effect

A fixed tool schema and one fixed (small) policy section, paid per request.

#### KV Cache effect

Prefix-stable while the tool definition and guidance section are unchanged.

## Known Limitations and Deferred Work

- **Duplicate detection is directory-scoped, not semantic** — `remember` hints same-directory ids; truly contradictory nodes under different ids or directories are found by the agent's own audit, not by the tool.
- **No branch operations yet** — git branches back the stores, but `branch/checkout/merge` are not exposed through the tool; the per-node timeline is live through `memory timeline`.
