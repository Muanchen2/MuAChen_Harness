# @deepseek-ai/dsh-memory-context

Rin memory context injection: the ancestor chain's memories ride the first turn.

## What this is

The read-side automation half of the Rin memory system. While the `memory` tool (`@deepseek-ai/dsh-tool-memory`) is the write/maintenance surface, this plugin renders every existing memory store along the workspace's **ancestor chain** — the directory tree itself: any level may carry its own `.dsh-memory`, and children inherit every ancestor's memories — ending at the central (global) store, into one user-role context message folded into the **first turn's** model request. A new session therefore starts with its relevant experience already present — no need to ask the agent to consult the `memory` tool.

Later turns do not re-inject: the first-turn context stays in the session history, and re-injecting the payload on every request would waste the context budget. From turn 2 on, the agent queries memory through the `memory` tool on demand.

The injection refreshes within the first turn when the agent writes memory through the `memory` tool, so a remembered conclusion reaches the very next step of that turn.

## Plugin

Injects `memories`.

### Config

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | `8192` | Max rendered context bytes; sections beyond the budget are dropped from the tail (farthest levels first). |

## Design

Composition mirrors `@deepseek-ai/dsh-agent-instructions`: the plugin keeps one pending context message per agent in the inbox, folds it into the request at `agent/pre-step`, and recomposes it when a `tools/result` from the `memory` tool reports a successful `remember`. The message source kind is `rin-memory`, so injected context is reconstructable from the session log like any other user message.

The chain resolves from the session's `header.cwd` upward through `@deepseek-ai/dsh-memory`'s `loadChain` (existing stores only — reads never materialize one); the central store never needs a workspace. All reads are git-backed, so they are durable and cheap at memory scale.

## Model Experience

### Request context and condition

#### What the model sees

One user-role context message in the first turn's request, when any store on the ancestor chain (or central) has memory — one section per store, nearest first:

```markdown
## Rin 记忆（workspace）

### Leaf（leaf）
leaf experience

## Rin 记忆（..）

### Parent（parent）
parent experience

## Rin 记忆（central）

### Git 工具路径（env/git-tool-path）
...
```

The session's own store is labelled `workspace`; ancestor stores use their `..`-relative path from the session directory. Empty stores contribute nothing.

#### Token effect

The rendered memory content plus its headings, bounded by `maxBytes` (default 8192 bytes). Paid once per session (first turn); later turns keep the content through the session history instead of re-injecting.

#### KV Cache effect

The context message sits between the claimed prompt and the driver-appended runtime context. Its text is stable while the underlying memory nodes are unchanged; writing or editing a memory node changes the payload for subsequent requests, breaking the prefix at that position.

## Known Limitations and Deferred Work

- **Injection is chain-wide, not relevance-ranked** — every level renders up to `maxBytes`. Relevance ranking and tag/weight models are deferred to the Rin tree model.
- **Per-step reads hit git** — each `agent/pre-step` and refresh reads store listings through git subprocess calls; fine at memory scale, but a projection cache should follow if stores grow large.
