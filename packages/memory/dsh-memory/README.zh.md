# @deepseek-ai/dsh-memory

[English](README.md) | 中文

Rin 记忆服务（`ctx.memories`）：基于 git 的跨会话项目经验记忆，与技能相区分。

## 这是什么

技能是方法——怎么做某事，稳定且可复用。记忆是经验——发生了什么、得出的结论、当前状态——跨会话增长和变化，且必须在新对话中存活。该服务让经验拥有基于 git 的持久化家园，因此每条记忆都带有可记录、可回滚的变更时间线和分支语义——正是项目历史存储（而非技能）需要的性质。

## 服务：`MemoryService`（ctx 键：`memories`）

### 公开 API

- `remember(scope, workspace, { id, title, content, message? })` — 写入一条记忆节点，把变更提交到 store。返回节点及其新时间线。
- `read(scope, workspace, id)` — 加载节点及其时间线，不存在时返回 `undefined`。
- `search(scope, workspace, query)` — 对节点正文与标题做不区分大小写的字面全文搜索，按匹配数排序；归档节点被排除。返回最多 10 条命中及首段摘要。
- `searchChain(workspace, query)` — 对祖先链上每个 store 加 central store 执行同样的搜索，每个 store 返回一组命中。
- `list(scope, workspace, prefix?)` — 一个 store 中排序后的记忆 id，递归扫描；不提供 `prefix` 时隐藏归档 id（`archive/…`）。
- `timeline(scope, workspace, id)` — 节点完整的逐文件变更历史，最新的在前。最早的提交为 `created`，之后为 `updated`；每条记录携带其底层 git `revision`，供未来的 revert/diff 操作寻址。重命名会被跟踪（`git log --follow`），因此移入层级目录的节点保留移动前历史。
- `diff(scope, workspace, id)` — 节点最近一次变更的统一 diff（恰好只创建过一次时为空）。
- `revert(scope, workspace, id, revision)` — 把节点恢复到过去的 `timeline` revision，以新变更提交，因此回滚本身也在时间线上。
- `remove(scope, workspace, id)` — 永久删除节点（已提交；可通过 git 历史回滚）。节点不存在时抛错。
- `archive(scope, workspace, id)` / `unarchive(scope, workspace, id)` — 把节点移到 `archive/<id>` 及其反向，各自提交。归档节点离开 `list` 与上下文注入，但仍可读作 `archive/<id>`；`unarchive` 接受归档 id 或裸 id。
- `ancestorStores(workspace)` — `workspace` 祖先链上已存在的 `.dsh-memory` store，最近的在前，止于文件系统根。缺失层级被跳过且从不创建。
- `listChain(workspace)` / `loadChain(workspace)` — 祖先链上每个已存在 store 的 id（或完整节点），最近的在前；即注入视图。
- `readChain(workspace, id)` — 从祖先链读取一个节点，最近的 store 优先，返回持有它的 store 路径。

### 祖先链

层级就是目录树本身，而不是一组固定 scope：任意目录层都可携带自己的 `.dsh-memory` store，子目录继承所有祖先的记忆。链式读取从 `workspace` 向上走到文件系统根，最近的在前，跳过没有 store 的层级——并且从不物化 store（链式读取只读）。`central` store 位于链顶：`listChain`、`loadChain` 与 `readChain` 在目录层级之后追加它（有内容时）。

### Id 与层级

记忆 id 映射到 store 相对路径：`/` 分隔的 id 变成嵌套目录（`bugfix/enoent` → `bugfix/enoent.md`），写入时创建，`list` 递归扫描。`.git` 目录和任何 `README.md` 永不被计为记忆。非法 id（空段、`..`、`.`、反斜杠、首尾斜杠、空白、Windows 不友好字符）以 `memory: invalid id "…"` 拒绝。

### 分支名

分支名是一个或多个 `/` 连接的小写 kebab 段（如 `task-x/attempt-a`）；每段以小写字母或数字开头和结尾。`branch` 在 git 操作前拒绝任何其他形式——大写、下划线、空白、非 ASCII、首尾或连续 `/`、`-` 开头的段——错误为 `memory: branch name "…" is invalid`，使并行结论线保持机器可输入。

### 归档与删除

记忆只通过 `remember` 增长；目录靠两个显式生命周期动作保持精简。`archive` 把节点归档到 `archive/<id>`——从列表和上下文注入中隐藏，仍可按需读取——用于被取代但值得保留的结论。`remove` 直接删除节点，用于错误和测试噪音；与每次写入一样它也是一次 git 提交，因此两种动作都可通过历史回滚，`git log --follow` 会跨移动保留归档节点的时间线。

### Scope

| `scope` | store 位置 | 用途 |
|---|---|---|
| `workspace` | `<workspace>/.dsh-memory` | 项目旁的项目经验 |
| `central` | `~/.dsh/memory` | 跨项目可复用知识（工具路径、约定） |

`workspace` scope 需要工作区路径；`central` scope 永远不需要。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `centralRoot` | `~/.dsh/memory` | central store 目录 |

### 事件

无——该服务不持有持久会话日志。

## 设计

- **git 作为记忆基底。** 每个 store 都是通过 `ctx.subprocess` 操作的 git 仓库（绝不使用原始 `node:child_process`），因此写入就是提交：可记录、可回滚、可分支。服务在其上叠加记忆节点结构与时间线。
- **技能/记忆分离。** 方法属于技能；经验属于这里。见面向模型的消费方。
- **写入被串行化。** 记忆服务是每个会话共享的宿主单例；一次写入（文件变更加提交）通过模块级队列原子执行，使并行会话无法交错它们的暂存。仍然在 `index.lock` 上冲突的 git 调用——跨进程场景——会以短退避重试。

## 模型体验

间接，通过 `@deepseek-ai/dsh-tool-memory`，它渲染用于记录和回顾经验的 `memory` 工具。

#### KV Cache 影响

无直接提示词影响；消费方拥有任何模型面向的渲染。

## 已知限制与暂缓事项

- **链式读取是扁平合并，不是排序检索** — 每一层渲染最多 `maxBytes`；相关性排序与标签/权重模型推迟到 Rin 树模型。
