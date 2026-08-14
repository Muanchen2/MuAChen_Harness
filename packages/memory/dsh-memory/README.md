# @deepseek-ai/dsh-memory

Rin memory service (`ctx.memories`): cross-session project-experience memory backed by git, distinct from skills.

## What this is

Skills are methods — how to do something, stable and reusable. Memories are experience — what happened, conclusions reached, current state — which grows and changes across sessions and must survive new conversations. This service gives that experience a durable home backed by git, so each memory carries a recorded, revertable change timeline and branch semantics, exactly the properties a project-history store (and not a skill) needs.

## Service: `MemoryService` (ctx key: `memories`)

### Public API

- `remember(scope, workspace, { id, title, content, message? })` — Write one memory node, committing the change to the store. Returns the node and its new timeline.
- `read(scope, workspace, id)` — Load a node plus its timeline, or `undefined` when absent.
- `list(scope, workspace)` — The sorted memory ids in a store.
- `timeline(scope, workspace, id)` — The node's complete per-file change history, newest first. The earliest commit is `created`, later commits `updated`; every entry carries its backing git `revision`, so future revert/diff operations can address it.

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

- **Hierarchy is flat** — nodes live at the store root; the "branch of a branch" tree and shared subtrees are expressible via git branches but not yet surfaced as first-class API.
- **No revert/diff yet** — timeline entries carry revisions, but `revert` (check out an older revision of a node) and `diff` (show what a revision changed) are not yet exposed as service operations.
