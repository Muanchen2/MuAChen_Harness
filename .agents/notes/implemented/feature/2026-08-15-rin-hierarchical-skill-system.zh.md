# Agent Note: Rin 层级化技能系统

Status: implemented

[English](2026-08-15-rin-hierarchical-skill-system.md) | 中文

## 问题

随附的技能文件系统提供方只扫描固定的两级根目录：最近的 `.git` 项目根和用户根（`<dshHome>/skills`、`<agentsHome>/skills`）。用户根按设计是全局的，因此像 `investing` 知识库这样的用户全局技能会被注入每个项目会话——Blender 会话也会弹出投资技能。Rin 记忆系统用目录链层级解决了同类问题（任意目录层都可带自己的存储，子目录继承祖先）。技能需要同构的布局，但不能与记忆存储耦合。

## 决策

文件系统提供方新增 `rootMode: 'rin'` 配置。Rin 模式的根目录为：

- `<cwd>/.dsh-skills`，然后从近到远是每个祖先目录的 `.dsh-skills`。目录链使用负 rank（最远为 `-n`，最近为 `-1`），因此无论链有多深，较近目录始终优先覆盖同名 skill。
- 项目兼容根 `<projectRoot>/.dsh/skills` 与 `<projectRoot>/.agents/skills`，rank 为 100/200，仓库本地指令继续可用。
- `<dshHome>/skills` 作为通用用户层（rank 400）。
- 用户级 `<agentsHome>/skills` 被排除，因此用户全局技能不会进入 Rin 会话。已配置的自定义根和 bundled 根仍为显式附加项。

`@deepseek-ai/dsh-rin-skill-filesystem` 是一个薄插件入口，固定 `providerName: 'rin-filesystem'` 与 `rootMode: 'rin'`，并委托给现有文件系统实现——frontmatter 解析、正文加载、`fs/observed` 失效和 watcher 生命周期全部共享，不重复实现。`skill` 工具、会话目录和 GUI 斜杠菜单继续读取同一个 `ctx.skills` 注册表，因此 Rin 会话的目录与 loader 和标准提供方保持一致。

watcher 管理器现在会释放从某 cwd 链中消失的根（共享根和按工作区划分的项目根），并在监听拓扑变化时使注册表缓存失效，因此切换会话 cwd 不会留下陈旧 watcher 或缓存目录。

`SkillSource` 新增 `rin-workspace` 与 `rin-user`，供消费方标注链上贡献。

## 曾考虑的替代方案

**给技能注册表和工具加 provider 名称过滤。** 否决：它会把 GUI 斜杠菜单、目录 digest 和 loader 拆到第二条选择轴上，而注册表契约已经按层和 rank 解决重名。隔离属于发现根，不属于新的读取选项。

**另建一个重新实现发现的层级提供方包。** 否决：frontmatter 解析、watcher 和正文加载会被复制并漂移。wrapper 委托给已交付实现。

**把 `investing` 留在用户全局层。** 否决：那正是要修复的污染。该技能已迁移到 `D:\Software\Work-software\量化\.dsh-skills\investing`，通用技能（`knowledge-hub`、`knowledge-write`）留在 `<dshHome>/skills`。

## 后果

Rin preset（用户的 `rin` 与 `rin-opt` agent preset）挂载 `rin-skill-filesystem`，其工作区链之外的用户全局技能不再被广播。标准 preset 保持两级行为不变。`gen-cordis-catalog` 策略现在把 `ctx.memories` 类型（文档在 dsh-memory README）和 `Array` 归类为基础类型，`gen-doc-graphs` 归类 `memories` 服务角色；两者都是 Rin 技能改动通过文档门时暴露的既有文档缺口。

层级是根目录的继承，不是嵌套 skill id：skill 名称仍为 kebab-case，每个根仍只发现一层。嵌套 id 仍为暂缓事项。
