/**
 * Rin memory data model.
 *
 * A memory node is one addressable record of project experience — something
 * that happened, a conclusion reached, the current state of a position, a
 * lesson learned — stored separately from skills (methods). Unlike a skill, a
 * memory node carries a parent (so memories form a tree: a domain, its
 * sub-branches, and shared subtrees) and an append-only change timeline backed
 * by git commits, so edits are recorded and revertable.
 *
 * @module @deepseek-ai/dsh-memory/types
 */

/**
 * One memory node.
 * @param id - stable identity within its store; used as the addressable name.
 * @param title - short human-facing title for the memory entry.
 * @param content - the memory body; how much the agent should retain.
 * @param scope - which store owns it: the workspace store or the central (global) store.
 * @param branch - the git-style branch (a strategy variant or sub-branch) this node lives on.
 */
export interface MemoryNode {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly scope: MemoryScope
  readonly branch: string
}

/**
 * Which store a memory lives in.
 * `workspace` is the per-workspace store (project experience); `central` is the
 * cross-project store (shared reusable knowledge such as tool paths).
 */
export type MemoryScope = 'workspace' | 'central'

/**
 * One entry in a memory node's change timeline.
 * @param revision - the git commit hash backing this change; addressable by future revert/diff.
 * @param at - commit time, ISO 8601.
 * @param action - what changed.
 * @param title - the title after this change, for quick scanning.
 */
export interface MemoryTimelineEntry {
  readonly revision: string
  readonly at: string
  readonly action: 'created' | 'updated' | 'deleted' | 'relinked'
  readonly title?: string
  readonly message: string
}

/**
 * The outcome of writing a memory node: the full node plus its new timeline.
 * @param node - the stored node after the write.
 * @param timeline - the node's complete change history, newest first.
 */
export interface MemoryWriteResult {
  readonly node: MemoryNode
  readonly timeline: MemoryTimelineEntry[]
}

/**
 * One store on the ancestor chain with its memory node ids.
 * @param store - absolute store directory (`<dir>/.dsh-memory`).
 * @param ids - sorted node ids in that store.
 */
export interface ChainStore {
  readonly store: string
  readonly ids: string[]
}

/**
 * One store on the ancestor chain with its full nodes, for injection-style
 * consumers that render every level.
 * @param store - absolute store directory.
 * @param scope - `workspace` for directory-chain stores, `central` for the global store.
 * @param nodes - the store's memory nodes.
 */
export interface ChainContent {
  readonly store: string
  readonly scope: MemoryScope
  readonly nodes: MemoryNode[]
}

/**
 * One merge conflict: a memory node changed on both branches.
 * @param id - the conflicting node id.
 * @param toContent - the version on the merge target (current) branch.
 * @param fromContent - the version on the merged branch.
 */
export interface MergeConflict {
  readonly id: string
  readonly toContent: string
  readonly fromContent: string
}

/**
 * The outcome of merging one branch into the current one.
 * @param merged - node ids the merge brought in (clean merges).
 * @param conflicts - nodes changed on both sides; the merge was rolled back and
 *   the caller must reconcile these (e.g. update the target node) before retrying.
 */
export interface MergeResult {
  readonly merged: string[]
  readonly conflicts: MergeConflict[]
}

/**
 * One full-text search hit inside a store.
 * @param id - the matching node id.
 * @param title - the node's heading.
 * @param snippet - the first matching line, trimmed.
 * @param matchCount - how many lines matched (the ranking key).
 */
export interface SearchHit {
  readonly id: string
  readonly title: string
  readonly snippet: string
  readonly matchCount: number
}

/**
 * The unified diff of a node's most recent change.
 * @param id - the node id.
 * @param diff - diff text; empty when the node was created exactly once and
 *   has nothing to diff yet.
 */
export interface NodeDiff {
  readonly id: string
  readonly diff: string
}
