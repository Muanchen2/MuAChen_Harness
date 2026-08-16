# @deepseek-ai/dsh-skill-admin

[English](README.md) | 中文

git 底座 Rin 技能库之上的面向模型 `skill-admin` 工具。

## 这是什么

给 agent 技能系统的"写/维护面"，区别于只读的 `skill` 工具：创建、更新、归档、删除、列出、查看历史、回滚、手动补 commit、把临时脚本提升为正式技能。每个技能层级是独立 git 仓库，所有写动作自动 commit 且可回滚——无 branch/merge，只有记录在案的单线历史。

## 插件

注入 `tools`、`skills` 与 `systemPrompt`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sectionOrder` | `116` | 策略引导段在提示词中的顺序。 |
| `dshHome` | `resolveDshHome()` | 解析后的 `$DSH_HOME`；user 层级为 `<dshHome>/skills`。 |

## 工具：`skill-admin`

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `create` / `update` / `archive` / `remove` / `list` / `history` / `revert` / `commit` / `promote` |
| `target` | string | `user`（`~/.dsh/skills`）或 `workspace`（会话 cwd 最近的 `.dsh-skills` 祖先；不存在时建在 cwd）。按技能的动作默认 `workspace`；`list` 忽略它。 |
| `name` | string | kebab-case 技能名；除 `list`/`commit` 外每个动作必填。 |
| `description` | string | `create`/`promote` 必填的非空描述；`update` 时作为可选字段更新。 |
| `whenToUse` / `script` / `runtime` | string | `create`/`update`/`promote` 的可选 frontmatter 字段。 |
| `content` | string | `SKILL.md` 正文：`create`/`promote` 必填，`update` 时替换正文。 |
| `revision` | string | `revert` 要恢复的 git revision（从 `history` 取）。 |
| `source` | string | `promote` 的源脚本路径（绝对或相对 cwd）。 |
| `message` | string | 可选的一行提交说明；每个动作有默认生成。 |

每个写动作自动 commit。`archive` 把技能移入 `<root>/_archived/<name>/`，发现逻辑忽略它（下划线开头的根条目视为内部）；`history` 仍能跨移动追踪，`revert` 就地恢复文件内容。`commit` 记录工作区未提交的变更（例如用文件工具编辑 `SKILL.md` 之后）。`promote` 把零散脚本复制进 `<root>/<name>/` 并生成带 `script`/`runtime` frontmatter 的 `SKILL.md`；触发判定由 agent 决定（同一脚本被 2+ 任务复用，或主人点名固化）。

## 设计

该包是技能能力 seam 的消费方角色；发现与加载位于 `@deepseek-ai/dsh-skill-filesystem`。它渲染工具与一段策略引导，并分发到 `SkillAdminManager`，后者通过 `ctx.subprocess`（绝不用裸 `child_process`）操作 git 底座存储。manager 跨会话串行化写操作，避免并行 agent 交错文件写入与 git 暂存。

## 模型体验

### 请求上下文与条件

#### 模型看到什么

带 `create/update/archive/remove/list/history/revert/commit/promote` 动作的 `skill-admin` 工具，以及一段简短策略引导，说明写/维护角色、user/workspace 层级与 promote 触发条件。

##### 引导段逐字文本

```markdown
使用 skill-admin 工具管理技能库（写/维护面），区别于只读的 skill 工具：创建/更新/归档/删除技能、查看与回滚历史、手动补 commit、把 .tmp 脚本提升为正式技能。技能层级：user=~/.dsh/skills（跨项目共享）、workspace=当前工作区最近的 .dsh-skills（项目内）。每层是独立 git 仓库，写动作自动 commit，随时可 history/revert；技能单线演进，没有 branch/merge。promote 判定：同一脚本被 2+ 任务复用，或主人点名要求固化时。skill-admin 只管理 skill 文件，不碰记忆（记忆用 memory 工具）。
```

#### Token 影响

固定工具 schema 加一段固定（简短）策略引导，每次请求都计费。

#### KV Cache 影响

工具定义与引导段不变时前缀稳定。

## 已知局限与后续工作

- **`update` 会重写 frontmatter 块** —— YAML 被解析、合并、重新序列化，既有 frontmatter 中的注释或格式不会保留。
- **没有 `unarchive` 动作** —— 恢复已归档技能意味着把它的 `SKILL.md` 回滚到归档前的 revision（`revert`），就地恢复内容；归档目录本身保留。
- **`revert` 只恢复 `SKILL.md`** —— 伴随文件（如提升的脚本）不会从旧 revision 恢复。
