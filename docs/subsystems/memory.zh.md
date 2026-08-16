# 记忆

[English](memory.md) | 中文

[Rin 记忆家族](../../packages/memory) 是跨会话的项目经验存储：Service Definition（[dsh-memory](../../packages/memory/dsh-memory)，`ctx.memories`）、面向模型的消费方（[dsh-tool-memory](../../packages/memory/tool-memory)）、首轮目录注入（[dsh-memory-context](../../packages/memory/memory-context)）和轮次末沉淀判断（[dsh-memory-accumulate](../../packages/memory/memory-accumulate)）。技能是方法——稳定、可复用、低频更新。记忆是经验——发生了什么、结论、当前状态——跨会话增长、变化并被归档。

来源：[`packages/memory/dsh-memory/src/index.ts`](../../packages/memory/dsh-memory/src/index.ts)。

## 存储布局

一条记忆存放在 git 支撑的存储中：每个 store 是一个 git 仓库，通过 `ctx.subprocess` 操作（绝不使用原始 `node:child_process`），因此每次写入都是一次提交——可记录、可回滚、可分支。

| `scope` | 存储位置 | 用途 |
|---|---|---|
| `workspace` | `<workspace>/.dsh-memory` | 项目旁的项目经验 |
| `central` | `<dshHome>/memory` | 跨项目可复用知识（工具路径、约定） |

`workspace` scope 需要工作区路径；`central` scope 永远不需要。

### 祖先链

层级就是目录树本身：任意目录层都可携带自己的 `.dsh-memory` store，子目录继承所有祖先的记忆。链式读取从工作区向上走到文件系统根，最近的优先，跳过没有 store 的层级——并且从不物化 store（链式读取只读）。`central` store 在有内容时位于链顶。`ancestorStores`、`listChain`、`loadChain` 和 `readChain` 暴露这一视图；注入消费方把它渲染成标题与 id 的目录。

## 节点模型

记忆 id 映射到 store 相对路径：`/` 分隔的 id 变成嵌套目录（`bugfix/enoent` → `bugfix/enoent.md`），写入时创建，`list` 递归扫描。`.git` 目录和任何 `README.md` 永不被计为记忆。非法 id 在任何 git 操作前以 `memory: invalid id "…"` 拒绝。

每个节点带变更时间线：最早的提交是 `created`，之后是 `updated`；`diff` 显示最近一次变更，`revert <revision>` 把过去状态恢复成新提交，重命名会被跟踪（`git log --follow`）。`archive` 把节点归档到 `archive/<id>`——从列表和注入中隐藏，仍可按需读取——`unarchive` 恢复；`remove` 彻底删除。两者都是提交，因此每个动作都能通过历史回滚。

分支名由 `/` 连接的小写 kebab 段组成（`task-x/attempt-a`）；`branch`/`checkout`/`merge` 让并行结论线保持机器可输入，`merge` 在冲突时回滚并按节点报告双方，由调用方调和。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemories--memoryservice"></a>

### `ctx.memories` — `MemoryService`

Memory store service over git-backends.

```ts cordis-catalog
/**
 * Write one memory node to a store, committing the change so it is recorded
 * and revertable.
 * @param scope - which store to write into.
 * @param workspace - resolver for the workspace path (used only for `scope: 'workspace'`).
 * @param input - the memory title/content and the message describing this change.
 * @returns the node and its full change timeline.
 */
async remember( scope: MemoryScope, workspace: string | undefined, input: { id: string; title: string; content: string; message?: string }, ): Promise<MemoryWriteResult>

/**
 * Read one memory node and its timeline.
 * @param scope - which store to read from.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @returns the node and timeline, or undefined when absent.
 */
async read( scope: MemoryScope, workspace: string | undefined, id: string, ): Promise<{ node: MemoryNode; timeline: MemoryTimelineEntry[] } | undefined>

/**
 * Full-text search one store: case-insensitive literal matches over node
 * bodies, ranked by match count. Archived nodes are excluded.
 * @param scope - which store to search.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param query - the literal text to find; empty queries yield no hits.
 * @returns the top hits, best match first.
 */
async search(scope: MemoryScope, workspace: string | undefined, query: string): Promise<SearchHit[]>

/**
 * Full-text search every store on the ancestor chain, nearest first, then
 * the central store — the search counterpart of `loadChain`.
 * @param workspace - the directory whose ancestor chain to search.
 * @param query - the literal text to find.
 * @returns one entry per store with at least one hit.
 */
async searchChain(workspace: string, query: string): Promise<Array<{ store: string; hits: SearchHit[] }>>

/**
 * List the current memory node ids in a store.
 * @param scope - which store to scan.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param prefix - optional id prefix filter; when omitted, archived nodes
 *   (`archive/…`) are hidden so the active catalogue stays lean.
 * @returns the sorted list of matching node ids.
 */
async list(scope: MemoryScope, workspace: string | undefined, prefix?: string): Promise<string[]>

/**
 * Read a memory node's complete change history, newest first.
 *
 * The earliest commit that touched the node's file is `created`; every later
 * commit is `updated`. Entries carry the backing git revision so future
 * revert/diff operations can address them.
 * @param scope - which store to read from.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @returns the timeline entries.
 */
async timeline(scope: MemoryScope, workspace: string | undefined, id: string): Promise<MemoryTimelineEntry[]>

/**
 * Unified diff of a node's most recent change.
 * @param scope - which store to read from.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @returns the diff, with an empty `diff` when the node was created exactly once.
 * @throws when the node has no history (does not exist).
 */
async diff(scope: MemoryScope, workspace: string | undefined, id: string): Promise<NodeDiff>

/**
 * Restore a node to a previous revision, committed as a new change. The
 * revert itself lands on the timeline, so nothing is ever lost.
 * @param scope - which store to operate on.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @param revision - the git revision to restore (from `timeline`).
 * @returns the reverted node and its updated timeline.
 * @throws when the revision does not contain the node.
 */
async revert( scope: MemoryScope, workspace: string | undefined, id: string, revision: string, ): Promise<MemoryWriteResult>

/**
 * Collect the existing memory stores along `workspace`'s ancestor chain,
 * nearest first, ending at the filesystem root. Levels without a store are
 * skipped and NEVER created — chain reads must not materialize stores.
 * @param workspace - the directory whose ancestor chain to walk.
 * @returns absolute store directories (`<dir>/.dsh-memory`), nearest first.
 */
async ancestorStores(workspace: string): Promise<string[]>

/**
 * List the memory node ids of the complete inheritance chain: every existing
 * store along `workspace`'s ancestor directories, nearest first, followed by
 * the central (global) store when it has content.
 * @param workspace - the directory whose ancestor chain to walk.
 * @returns one entry per existing, committed store on the chain.
 */
async listChain(workspace: string): Promise<ChainStore[]>

/**
 * Load every memory node of the complete inheritance chain — the injection
 * view: ancestor-directory stores nearest first, then the central store.
 * @param workspace - the directory whose ancestor chain to walk.
 * @returns one entry per existing, committed store with its full nodes.
 */
async loadChain(workspace: string): Promise<ChainContent[]>

/**
 * Read one node from the complete inheritance chain, nearest store first,
 * falling back to the central store.
 * @param workspace - the directory whose ancestor chain to walk.
 * @param id - the memory node id.
 * @returns the node, its timeline, and the store that held it; undefined when absent everywhere.
 */
async readChain( workspace: string, id: string, ): Promise<{ node: MemoryNode; timeline: MemoryTimelineEntry[]; store: string } | undefined>

/**
 * Create a branch from the current HEAD and switch to it — the start of a
 * parallel conclusion line (e.g. two approaches explored at once).
 * @param scope - which store to branch.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param name - the new branch name, in the format `task-x/attempt-a`.
 * @throws when `name` violates the branch-name format.
 * @returns the created branch name.
 */
async branch(scope: MemoryScope, workspace: string | undefined, name: string): Promise<{ branch: string }>

/**
 * Switch to an existing branch.
 * @param scope - which store to switch in.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param name - the branch to switch to.
 * @returns the active branch name.
 */
async checkout(scope: MemoryScope, workspace: string | undefined, name: string): Promise<{ branch: string }>

/**
 * The current branch name of a store.
 * @param scope - which store to read.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @returns the active branch name, or undefined when the store has no commits yet.
 */
async currentBranch(scope: MemoryScope, workspace: string | undefined): Promise<string | undefined>

/** Every branch of a store, sorted.
 * @param scope - which store to list.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @returns the branch names of the store, sorted lexically.
 */
async listBranches(scope: MemoryScope, workspace: string | undefined): Promise<string[]>

/**
 * Merge `from` into the current branch. A clean merge commits and reports
 * the node ids it brought in. Conflicts roll the merge back and report both
 * sides per node — the caller reconciles (e.g. updates the target node to a
 * combined conclusion) and retries, optionally with a conflict strategy that
 * resolves conflicts in favor of the current branch (`ours`) or the merged
 * branch (`theirs`).
 * @param scope - which store to merge in.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param from - the branch to merge into the current one.
 * @param strategy - conflict resolution strategy for the merge.
 * @returns the merge outcome: committed node ids on success, or per-node conflicts to reconcile.
 */
async merge( scope: MemoryScope, workspace: string | undefined, from: string, strategy?: 'ours' | 'theirs', ): Promise<MergeResult>

/**
 * Permanently delete a node from a store, committed so the removal is
 * recorded and revertable through git history.
 * @param scope - which store to remove from.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @throws when the node does not exist.
 */
async remove(scope: MemoryScope, workspace: string | undefined, id: string): Promise<void>

/**
 * Move a node out of the active catalogue into `archive/<id>`, committed.
 * Archived nodes are hidden from listings and context injection but remain
 * readable as `archive/<id>` and restorable via `unarchive`.
 * @param scope - which store to archive in.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the memory node id.
 * @returns the archived id (`archive/<id>`).
 * @throws when the node does not exist.
 */
async archive(scope: MemoryScope, workspace: string | undefined, id: string): Promise<{ id: string }>

/**
 * Restore an archived node back to its original id, committed. Accepts the
 * archived id (`archive/<id>`) or the bare original id.
 * @param scope - which store to restore in.
 * @param workspace - workspace path (used only for `scope: 'workspace'`).
 * @param id - the archived (or original) node id.
 * @returns the restored id.
 * @throws when no archived node exists for that id.
 */
async unarchive(scope: MemoryScope, workspace: string | undefined, id: string): Promise<{ id: string }>
```

Source: [`packages/memory/dsh-memory/src/index.ts:89`](../../packages/memory/dsh-memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
