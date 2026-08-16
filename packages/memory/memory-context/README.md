# @deepseek-ai/dsh-memory-context

English | [中文](README.zh.md)

Rin memory context injection: the ancestor chain's memories ride the first turn.

## What this is

The read-side automation half of the Rin memory system. While the `memory` tool (`@deepseek-ai/dsh-tool-memory`) is the write/maintenance surface, this plugin renders every existing memory store along the workspace's **ancestor chain** — the directory tree itself: any level may carry its own `.dsh-memory`, and children inherit every ancestor's memories — ending at the central (global) store, into one **catalogue** (titles and ids) folded into the **first turn's** model request. The agent then reads what is relevant through the `memory` tool instead of receiving every memory body — no need to ask the agent to consult the `memory` tool to know what exists.

Later turns do not re-inject: the first-turn context stays in the session history, and re-injecting the payload on every request would waste the context budget. From turn 2 on, **automatic recall** takes over instead: each request retrieves the top-N most relevant stored memories and injects their summaries, so the agent reasons with relevant experience at hand like a human recalling it — without being asked. Queries are built with priority: the user's direct words first, then concrete entities from the latest reasoning block (session ids, commit hashes, error codes, file paths — grounded facts of the current thinking, never its speculative wording), then the recent execution context (the latest tool results and assistant replies) as fill-in. Ids already recalled in this session are not repeated, handoff memos are excluded (they have their own pickup channel), and the agent can expand any summary with `memory read`.

The injection refreshes within the first turn when the agent writes memory through the `memory` tool, so a remembered conclusion reaches the very next step of that turn.

## Plugin

Injects `memories`.

### Config

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | `8192` | Max rendered context bytes; sections beyond the budget are dropped from the tail (farthest levels first). |
| `recallTopN` | `3` | Automatic recall from turn 2 on: top-N relevant memory summaries injected per request (`0` disables). |
| `recallCandidates` | `10` | Keyword pre-filter cap: the cheap keyword pass keeps the top-`recallCandidates` matches before the optional LLM re-rank. |
| `recallRerankTimeoutMs` | `15000` | Timeout for the one LLM re-rank call (only paid when the keyword pass over-produces). |
| `provider` / `model` | — | Explicit route for the re-rank call; defaults to the session's latest `request/header` route. |

## Design

Composition mirrors `@deepseek-ai/dsh-agent-instructions`: the plugin keeps one pending context message per agent in the inbox, folds it into the request at `agent/pre-step`, and recomposes it when a `tools/result` from the `memory` tool reports a successful `remember`. The message source kind is `rin-memory`, so injected context is reconstructable from the session log like any other user message.

The chain resolves from the session's `header.cwd` upward through `@deepseek-ai/dsh-memory`'s `loadChain` (existing stores only — reads never materialize one); the central store never needs a workspace. All reads are git-backed, so they are durable and cheap at memory scale.

## Model Experience

### Request context and condition

#### What the model sees

One user-role catalogue message in the first turn's request, when any store on the ancestor chain (or central) has memory — one section per store, nearest first, listing titles and ids only. Contents are fetched on demand through the `memory` tool, so the agent chooses what is relevant instead of receiving everything:

##### Catalogue message

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

##### Store labels

```markdown
The session's own store is labelled `workspace`; ancestor stores use their `..`-relative path from the session directory. Empty stores contribute nothing.
```

#### Token effect

The catalogue lists titles and ids only (bounded by `maxBytes`, default 16384 bytes — enough for hundreds of entries), plus one fetch-hint line. Contents are paid only when the agent reads them. Paid once per session (first turn); later turns keep the catalogue through the session history instead of re-injecting.

Automatic recall is two-stage: a cheap keyword pass (`searchChain`) keeps the top-`recallCandidates` matches and injects them directly when they fit the `recallTopN` budget (zero LLM cost). Only when the keyword pass over-produces does one auxiliary LLM call re-rank the candidates semantically (≤128 output tokens, `recallRerankTimeoutMs` cap); a failing or slow re-rank falls back to the keyword order, so recall never blocks on the model — the auxiliary call rides the session's route (explicit `provider`/`model` or the latest `request/header`).

#### KV Cache effect

The catalogue message sits between the claimed prompt and the driver-appended runtime context. Its text is stable while the underlying memory nodes are unchanged; writing or editing a memory node changes the payload for subsequent requests, breaking the prefix at that position. Recall injections are per-step and change with the surface, so they never share a stable prefix.

## Known Limitations and Deferred Work

- **Catalogue is chain-wide, not relevance-ranked** — every level lists up to `maxBytes`; the agent picks what to read. Relevance ranking and tag/weight models are deferred to the Rin tree model.
- **Per-step reads hit git** — each `agent/pre-step` and refresh reads store listings through git subprocess calls; fine at memory scale, but a projection cache should follow if stores grow large.
