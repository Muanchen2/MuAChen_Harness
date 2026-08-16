# @deepseek-ai/dsh-rin-skill-filesystem

[English](README.md) | 中文

`ctx.skills` 的层级化 Rin skill（技能）提供方。

该插件是本地 Rin skill 的入口。它将提供方名称固定为 `rin-filesystem`，并将发现模式固定为祖先链布局：`<cwd>/.dsh-skills`、从近到远的每个祖先目录 `.dsh-skills`，以及 DSH 用户根 `<dshHome>/skills`。较近的工作区根目录优先覆盖同名 skill。项目级 `.dsh/skills` 和 `.agents/skills` 作为低优先级兼容根保留，用于仓库本地指令；用户级 `.agents/skills` 被排除，因此全局 skill 不会进入 Rin 会话。

该插件将 frontmatter 解析、正文加载、文件系统观测和释放委托给 `@deepseek-ai/dsh-skill-filesystem`。注册表仍位于 `@deepseek-ai/dsh-skill`，而 `@deepseek-ai/dsh-tool-skill` 提供共享的面向模型目录和 loader。因此 Rin skill 与标准 skill 使用同一个 `skill` 工具，但存储根互不共享。

## 插件

需要 `ctx.skills`（`inject: ['skills']`）。配置与本地提供方拥有相同的 watcher 和根目录控制项，但 `providerName` 与 `rootMode` 由该包固定。

## 模型体验

通过 `@deepseek-ai/dsh-tool-skill` 间接影响模型；该包渲染 Rin 目录并加载所选 skill 正文。

#### KV Cache 影响

Rin 根目录或其 frontmatter 发生变化时，目录会变化。仅修改正文会影响后续加载，但不会改变目录 digest。

## 已知限制与暂缓事项

- Skill 名称仍采用 kebab-case，发现深度仍为每个根一层；层级来自继承的根目录，而不是嵌套 skill id。
