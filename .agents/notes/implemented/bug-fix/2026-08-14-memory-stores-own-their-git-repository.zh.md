# Agent Note: 记忆存储拥有自己的 git 仓库

Status: implemented

[English](2026-08-14-memory-stores-own-their-git-repository.md) | 中文

## Problem

`dsh-memory` 把每个 store 放在独立的 git 仓库中，但 `GitBackend.ensureRepo` 通过 `git rev-parse --is-inside-work-tree` 决定是否执行 `git init`。当 store 目录嵌套在某个无关仓库内部时——这是常见情况，因为 workspace store 位于 `<workspace>/.dsh-memory`，而大多数 workspace 本身就是 git 仓库——该探测会回答"是"，即使 store 并没有自己的仓库，于是 `git init` 被跳过。此后所有 git 操作都作用在外层仓库上：`git add -A` 把记忆文件暂存到外层，`commit` 写进外层历史，`read` 按外层树根解析 `HEAD:<id>.md` 永远找不到文件，`timeline` 报告的是外层 HEAD。store 静默污染了 workspace 仓库的历史，read 路径永远不可能成功。

## Decision

`GitBackend.ensureRepo` 现在检查 store 目录自身是否包含 `.git` 目录，仅在不存在时执行 `git init`。无论外层是否有仓库，store 都拥有自己的仓库：所有 git 命令仍以 store 为 cwd 运行并按 store 根解析路径，因此嵌套 store 的 read、list、timeline 均恢复正常，且永不触碰外层历史。该检查是对 `<store>/.git` 的普通 `fs.stat`，而不是 git 探测，因为问题是该目录的所有权，而非是否属于某个外层工作树。

同一改动也让 `dsh-memory` 的 invariant companion 符合包 invariant 契约：它现在注入 `invariants` 而不是 `memories`，与其他所有包的 companion 一致。

## Testing

`packages/memory/dsh-memory/tests/service.spec.ts` 通过 `ctx.subprocess` 用真实 git 覆盖 store 契约：嵌套在无关已提交仓库内的 store 保持自有（外层仓库的跟踪文件永不出现记忆文件，store 携带自己的 `.git`，`read`/`timeline` 成功），独立 workspace 的 record/read/list/timeline 正常，central store 无需 workspace 路径即可工作，读取缺失 id 返回 undefined，缺少 workspace 路径的 workspace 作用域操作被拒绝。

## Alternatives considered

**继续探测外层工作树并接受嵌套 workspace 的外层仓库污染。** 被拒绝，因为大多数 workspace 都是 git 仓库，该 bug 会成为默认体验，而且污染会写进无关的用户历史。

**将 `git rev-parse --absolute-git-dir` 与 `<store>/.git` 比对。** 被拒绝，因为答案仍来自可能被 worktree 和 gitfile 设置干扰的 git 探测，而文件系统检查直接陈述所有权问题；每次写入还少一次子进程调用。

**要求调用方自行初始化仓库，否则大声失败。** 被拒绝，因为服务契约承诺每个 scope 都有 git 后端的 store，而 `ensureRepo` 是唯一能统一建立它的位置。

## Consequences

在自身是仓库的 workspace 中创建的 store 不再向该仓库泄漏提交，且所有 store 的 `read` 均可用。所有权检查每次 store 写入多一次 `stat`，相比 git 子进程调用可以忽略。本改动之前在嵌套外层仓库内初始化的 store 没有自有 `.git`，且本就无法通过 `read` 使用；重建 store（或删除泄漏的外层提交）即可恢复正确行为，无需迁移任何内容。
