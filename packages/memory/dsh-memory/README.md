# @deepseek-ai/dsh-memory

Rin memory service (`ctx.memories`): cross-session project-experience memory backed by git, distinct from skills.

## What this is

Skills are methods — how to do something, stable and reusable. Memories are experience — what happened, conclusions reached, current state — which grows and changes across sessions and must survive new conversations. This service gives that experience a durable home backed by git, so each memory carries a recorded, revertable change timeline and branch semantics, exactly the properties a project-history store (and not a skill) needs.

## Service: `MemoryService` (ctx key: `memories`)

### Public API

- `remember(scope, workspace, { id, title, content, message? })` — Write one memory node, committing the change to the store. Returns the node and its new timeline.
- `read(scope, workspace, id)` — Load a node plus its timeline, or `undefined` when absent.
- `list(scope, workspace)` — The sorted memory ids in a store, scanned recursively.
- `timeline(scope, workspace, id)` — The node's complete per-file change history, newest first. The earliest commit is `created`, later commits `updated`; every entry carries its backing git `revision`, so future revert/diff operations can address it. Renames are followed (`git log --follow`), so a node moved into a hierarchy keeps its pre-move history.
- `ancestorStores(workspace)` — The existing `.dsh-memory` stores along `workspace`'s ancestor chain, nearest first, ending at the filesystem root. Absent levels are skipped and never created.
- `listChain(workspace)` / `loadChain(workspace)` — Ids (or full nodes) of every existing store on the ancestor chain, nearest first; the injection view.
- `readChain(workspace, id)` — Read one node from the ancestor chain, nearest store first, returning the owning store path.

### Ancestor chain

The hierarchy is the directory tree itself, not a fixed set of scopes: any directory level may carry its own `.dsh-memory` store, and children inherit every ancestor's memories. Chain reads walk from `workspace` upward to the filesystem root, nearest first, skipping levels without a store — and never materialize one (chain reads are read-only). The `central` store tops the chain: `listChain`, `loadChain`, and `readChain` append it after the directory levels when it has content.

### Ids and hierarchy

A memory id maps to a store-relative path: `/`-separated ids become nested directories (`bugfix/enoent` → `bugfix/enoent.md`), created on write and scanned recursively by `list`. The `.git` directory and any `README.md` are never counted as memories. Invalid ids (empty or blank segments, `..`, `.`, backslashes, leading/trailing slashes, whitespace, Windows-hostile characters) are rejected with `memory: invalid id "…"`.

### Scope

| `scope` | Store location | Purpose |
|---|---|---|
| `workspace` | `<workspace>/.dsh-memory` | Project experience beside the project |
| `central` | `~/.dsh/memory` | Cross-project reusable knowledge (tool paths, conventions) |

The `workspace` scope requires a workspace path; the `central` scope never does.

### Config

| Field | Default | Meaning |
|---|---|---|
| `centralRoot` | `~/.dsh/memory` | Central store directory |

### Events

None — the service owns no durable session log.

## Design

- **Git as the memory substrate.** Each store is a git repository operated through `ctx.subprocess` (never raw `node:child_process`), so writes are commits: recorded, revertable, and branchable. The service layers memory-node structure and timeline on top.
- **Skill/memory separation.** Methods belong in skills; experience belongs here. See the model-facing consumer.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-memory`, which renders the `memory` tool for recording and recalling experience.

#### KV Cache effect

No direct prompt effect; the consumer owns any model-facing rendering.

## Known Limitations and Deferred Work

- **Chain reads are flat merges, not ranked retrieval** — every level renders up to `maxBytes`; relevance ranking and tag/weight models are deferred to the Rin tree model.
- **No revert/diff yet** — timeline entries carry revisions, but `revert` (check out an older revision of a node) and `diff` (show what a revision changed) are not yet exposed as service operations.
- **No rename/delete API yet** — moving a node is a manual git operation on the store.
