# skill/：skill（技能）能力家族

[English](README.md) | 中文

本家族发现可复用的 agent（智能体）指令，并通过与提供方无关的目录和 loader 将其公开给模型。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`skill/`](skill/README.md) | 定义 skill 提供方注册和查找 | `ctx.skills` |
| [`skill-badge/`](skill-badge/README.md) | 贡献可选的内置 dsh 徽章 skill | 注册到 `ctx.skills` |
| [`skill-filesystem/`](skill-filesystem/README.md) | 从本地文件系统发现标准或 Rin 模式的 skill | 注册到 `ctx.skills` |
| [`rin-filesystem/`](rin-filesystem/README.md) | 提供固定的 Rin 层级文件系统提供方 | 注册到 `ctx.skills` |
| [`tool-skill/`](tool-skill/README.md) | 发布 skill 目录和面向模型的 loader | 注册到 `ctx.tools` |

该能力位于核心控制主干之外，可以使用本地、嵌入式或远程提供方，而无需更改面向模型的约定。文件系统提供方同时支持标准的项目／用户根和 Rin 可选的 `.dsh-skills` 祖先链；两种布局共享同一个注册表和面向模型的 loader。

子系统参考——发现优先级、目录快照、`skill` 加载器——见 [docs/subsystems/skills.md](../../docs/subsystems/skills.md)。
