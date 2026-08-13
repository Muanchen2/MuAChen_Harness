# @deepseek-ai/dsh-tool-memory

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
| `scope` | string | `workspace` or `central` |
| `id` | string | Node id for read/timeline, or the id to save under for remember |
| `title` / `content` | string | Heading/body for remember |
| `message` | string | Optional one-line commit note for this change |

The workspace store resolves from the calling session's `header.cwd`; the central store never needs one.

## Design

This package is the consumer role of the memory capability seam; the service and semantics live in `@deepseek-ai/dsh-memory`. It renders the tool and a policy guidance section, and dispatches to that service.

## Model Experience

### Request context and condition

#### What the model sees

A `memory` tool with `remember/read/list/timeline` actions and a short policy section explaining the skill/memory distinction.

##### Verbatim text for the guidance section

```markdown
Use memory tools to persist and recall cross-session project experience, distinct from skills (methods). Before a long task, recall the relevant workspace memory to restore prior conclusions and current state. After reaching a meaningful conclusion, a changed position, or a learned path, remember it so a future session can resume without repeating work. Keep memories factual and concise; store methods in skills, experience in memory.
```

#### Token effect

A fixed tool schema and one fixed (small) policy section, paid per request.

#### KV Cache effect

Prefix-stable while the tool definition and guidance section are unchanged.

## Known Limitations and Deferred Work

- **Memory semantics are flat** — hierarchy, per-node granular timeline, and shared-subtree recall are deferred to the service and not yet surfaced through the tool.
