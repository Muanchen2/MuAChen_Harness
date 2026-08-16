# @deepseek-ai/dsh-skill-admin

English | [中文](README.zh.md)

Model-facing `skill-admin` tool over the git-backed Rin skill stores.

## What this is

Gives the agent the write/maintenance side of the skill system, distinct from the read-only `skill` tool: create, update, archive, remove, list, history, revert, commit, and promote skills. Every skill layer is its own git repository, so every write is committed and revertable — no branch/merge, just a recorded single-line history.

## Plugin

Injects `tools`, `skills`, and `systemPrompt`.

### Config

| Field | Default | Meaning |
|---|---|---|
| `sectionOrder` | `116` | Order of the policy guidance section. |
| `dshHome` | `resolveDshHome()` | Resolved `$DSH_HOME`; the user layer is `<dshHome>/skills`. |

## Tool: `skill-admin`

| Arg | Type | Notes |
|---|---|---|
| `action` | string | `create` / `update` / `archive` / `remove` / `list` / `history` / `revert` / `commit` / `promote` |
| `target` | string | `user` (`~/.dsh/skills`) or `workspace` (nearest `.dsh-skills` ancestor of the session cwd; created at the cwd when absent). Defaults to `workspace` for per-skill actions; `list` ignores it. |
| `name` | string | Kebab-case skill name; required by every action except `list`/`commit`. |
| `description` | string | Required non-empty description for `create`/`promote`; optional field update for `update`. |
| `whenToUse` / `script` / `runtime` | string | Optional frontmatter fields for `create`/`update`/`promote`. |
| `content` | string | `SKILL.md` body: required for `create`/`promote`, replaces the body for `update`. |
| `revision` | string | Git revision to restore for `revert` (take it from `history`). |
| `source` | string | Source script path (absolute or cwd-relative) for `promote`. |
| `message` | string | Optional one-line commit message; a default is generated per action. |

Each write action commits automatically. `archive` moves the skill into `<root>/_archived/<name>/`, which discovery ignores (underscore-prefixed root entries are internal); `history` still traces it across the move and `revert` restores file content in place. `commit` records pending working-tree changes (for example after editing a `SKILL.md` with the filesystem tools). `promote` copies a loose script into `<root>/<name>/` and generates the `SKILL.md` with `script`/`runtime` frontmatter; the agent decides the trigger (reuse across 2+ tasks, or the owner naming it).

## Design

This package is the consumer role of the skill capability seam; discovery and loading live in `@deepseek-ai/dsh-skill-filesystem`. It renders the tool and a policy guidance section, and dispatches to `SkillAdminManager`, which operates the git-backed stores through `ctx.subprocess` (never raw `child_process`). The manager serializes writes across sessions so parallel agents cannot interleave file writes and git staging.

## Model Experience

### Request context and condition

#### What the model sees

A `skill-admin` tool with `create/update/archive/remove/list/history/revert/commit/promote` actions and a short policy section explaining the write/maintenance role, the user/workspace layers, and the promotion trigger.

##### Verbatim text for the guidance section

```markdown
使用 skill-admin 工具管理技能库（写/维护面），区别于只读的 skill 工具：创建/更新/归档/删除技能、查看与回滚历史、手动补 commit、把 .tmp 脚本提升为正式技能。技能层级：user=~/.dsh/skills（跨项目共享）、workspace=当前工作区最近的 .dsh-skills（项目内）。每层是独立 git 仓库，写动作自动 commit，随时可 history/revert；技能单线演进，没有 branch/merge。promote 判定：同一脚本被 2+ 任务复用，或主人点名要求固化时。skill-admin 只管理 skill 文件，不碰记忆（记忆用 memory 工具）。
```

#### Token effect

A fixed tool schema and one fixed (small) policy section, paid per request.

#### KV Cache effect

Prefix-stable while the tool definition and guidance section are unchanged.

## Known Limitations and Deferred Work

- **`update` rewrites the frontmatter block** — YAML is parsed, merged, and re-serialized, so comments or formatting in an existing frontmatter block are not preserved.
- **No `unarchive` action** — restoring an archived skill means reverting its `SKILL.md` to a pre-archive revision (`revert`), which restores content in place; the archive directory itself stays.
- **`revert` restores only `SKILL.md`** — companion files (e.g. a promoted script) are not restored from the old revision.
