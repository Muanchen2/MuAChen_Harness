/**
 * Rin memory service (`ctx.memories`).
 *
 * Cross-session project-experience memory distinct from skills. Skills are
 * methods — how to do something, stable and reusable. Memories are experience —
 * what happened, conclusions reached, current state — which grows and changes
 * across sessions and must survive new conversations. A memory lives in a git-
 * backed store, so it carries a change timeline and branches like a project.
 *
 * The service is storage-agnostic to scopes: `workspace` stores project
 * experience beside the project, `central` stores reusable cross-project
 * knowledge (tool paths, shared conventions). Both are git stores operated
 * through `ctx.subprocess`.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { Service, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GitBackend } from './git-backend.ts'
import type {
  ChainContent,
  ChainStore,
  MemoryNode,
  MemoryScope,
  MemoryTimelineEntry,
  MemoryWriteResult,
  MergeConflict,
  MergeResult,
  NodeDiff,
  SearchHit,
} from './types.ts'

export type { ChainContent, ChainStore, MergeConflict, MergeResult, NodeDiff, SearchHit } from './types.ts'

/** How many search hits one query returns, best match first. */
const SEARCH_MAX_HITS = 10

/**
 * Branch names are restricted to kebab-case segments joined by `/` (e.g.
 * `task-x/attempt-a`), so parallel conclusion lines stay machine-typed and
 * cannot smuggle git metacharacters or free-form labels into branch creation.
 * Each segment starts and ends with a lowercase letter or digit.
 * @param name - the proposed branch name.
 * @returns a model-facing error message, or undefined when the name is valid.
 */
export function branchNameError(name: string): string | undefined {
  if (name.length === 0) return 'memory:branch name must not be empty — use lowercase letters, digits, and hyphens, e.g. task-x/attempt-a'
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(name)) {
    return `memory:branch name "${name}" is invalid — use lowercase letters, digits, and hyphens (segments joined by /), e.g. task-x/attempt-a`
  }
  return undefined
}

/**
 * Serialize one store write across every session sharing this module. The
 * memory service is a host singleton; concurrent writes from parallel
 * sessions would interleave their file writes and `git add -A` staging, so a
 * write (file change plus its commit) must run atomically. Reads stay
 * concurrent.
 */
let writeTail: Promise<void> = Promise.resolve()
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeTail.then(task, task)
  writeTail = run.then(() => undefined, () => undefined)
  return run
}

/** Config for the memory service. Storage roots are directory locations for each store scope. */
export interface Config {
  /** Central (cross-project) memory store directory. Defaults to `<dshHome>/memory`. */
  centralRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memories: MemoryService
  }
}

/**
 * Memory store service over git-backends.
 * @param ctx - the host context.
 * @param config - resolved config.
 */
export class MemoryService extends Service {
  static Config: Schema<Config> = z.object({
    centralRoot: z.string(),
  })

  private readonly git: GitBackend
  private readonly centralRoot: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memories')
    this.git = new GitBackend(ctx)
    this.centralRoot = config.centralRoot ?? join(homedir(), '.dsh', 'memory')
  }

  /**
   * Write one memory node to a store, committing the change so it is recorded
   * and revertable.
   * @param scope - which store to write into.
   * @param workspace - resolver for the workspace path (used only for `scope: 'workspace'`).
   * @param input - the memory title/content and the message describing this change.
   * @returns the node and its full change timeline.
   */
  async remember(
    scope: MemoryScope,
    workspace: string | undefined,
    input: { id: string; title: string; content: string; message?: string },
  ): Promise<MemoryWriteResult> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const relPath = nodePath(input.id)
      await writeUtf8(join(dir, relPath), `# ${input.title}\n\n${input.content}\n`)
      await this.git.commit(dir, input.message ?? `memory: ${input.title}`)
      return {
        node: { id: input.id, title: input.title, content: input.content, scope, branch: 'default' },
        timeline: await this.timeline(scope, workspace, input.id),
      }
    })
  }

  /**
   * Read one memory node and its timeline.
   * @param scope - which store to read from.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param id - the memory node id.
   * @returns the node and timeline, or undefined when absent.
   */
  async read(
    scope: MemoryScope,
    workspace: string | undefined,
    id: string,
  ): Promise<{ node: MemoryNode; timeline: MemoryTimelineEntry[] } | undefined> {
    const dir = await this.resolveStore(scope, workspace)
    if (!(await this.git.hasCommits(dir))) return undefined
    const content = await this.git.readFile(dir, nodePath(id))
    if (content === undefined) return undefined
    const title = firstHeading(content) ?? id
    return { node: { id, title, content: stripHeading(content), scope, branch: 'default' }, timeline: await this.timeline(scope, workspace, id) }
  }

  /**
   * Full-text search one store: case-insensitive literal matches over node
   * bodies, ranked by match count. Archived nodes are excluded.
   * @param scope - which store to search.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param query - the literal text to find; empty queries yield no hits.
   * @returns the top hits, best match first.
   */
  async search(scope: MemoryScope, workspace: string | undefined, query: string): Promise<SearchHit[]> {
    const dir = await this.resolveStore(scope, workspace)
    return this.searchAt(dir, query)
  }

  /**
   * Full-text search every store on the ancestor chain, nearest first, then
   * the central store — the search counterpart of `loadChain`.
   * @param workspace - the directory whose ancestor chain to search.
   * @param query - the literal text to find.
   * @returns one entry per store with at least one hit.
   */
  async searchChain(workspace: string, query: string): Promise<Array<{ store: string; hits: SearchHit[] }>> {
    const found: Array<{ store: string; hits: SearchHit[] }> = []
    for (const store of await this.ancestorStores(workspace)) {
      if (!(await this.storeHasCommits(store))) continue
      const hits = await this.searchAt(store, query)
      if (hits.length > 0) found.push({ store, hits })
    }
    if (await this.storeHasCommits(this.centralRoot)) {
      const hits = await this.searchAt(this.centralRoot, query)
      if (hits.length > 0) found.push({ store: this.centralRoot, hits })
    }
    return found
  }

  /** Search one already-resolved store directory. */
  private async searchAt(dir: string, query: string): Promise<SearchHit[]> {
    if (query.length === 0 || !(await this.git.hasCommits(dir))) return []
    const byId = new Map<string, { title: string; snippet: string; count: number }>()
    for (const line of await this.git.grep(dir, query)) {
      const firstColon = line.indexOf(':')
      const path = firstColon < 0 ? line : line.slice(0, firstColon)
      if (!path.endsWith('.md') || path.startsWith('archive/')) continue
      const content = line.slice(firstColon + 1)
      const text = content.slice(content.indexOf(':') + 1).trim()
      if (text === '') continue
      const id = path.slice(0, -3)
      const entry = byId.get(id)
      if (entry === undefined) byId.set(id, { title: id, snippet: text, count: 1 })
      else entry.count += 1
    }
    const ranked = [...byId.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, SEARCH_MAX_HITS)
    const hits: SearchHit[] = []
    for (const [id, entry] of ranked) {
      const content = await this.git.readFile(dir, nodePath(id))
      hits.push({
        id,
        title: content === undefined ? entry.title : (firstHeading(content) ?? entry.title),
        snippet: entry.snippet,
        matchCount: entry.count,
      })
    }
    return hits
  }

  /**
   * List the current memory node ids in a store.
   * @param scope - which store to scan.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param prefix - optional id prefix filter; when omitted, archived nodes
   *   (`archive/…`) are hidden so the active catalogue stays lean.
   * @returns the sorted list of matching node ids.
   */
  async list(scope: MemoryScope, workspace: string | undefined, prefix?: string): Promise<string[]> {
    const dir = await this.resolveStore(scope, workspace)
    if (!(await this.git.hasCommits(dir))) return []
    const ids = await this.listMarkdownIds(dir)
    if (prefix === undefined) return ids.filter(id => !id.startsWith('archive/'))
    return ids.filter(id => id.startsWith(prefix))
  }

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
  async timeline(scope: MemoryScope, workspace: string | undefined, id: string): Promise<MemoryTimelineEntry[]> {
    const dir = await this.resolveStore(scope, workspace)
    return this.timelineAt(dir, nodePath(id))
  }

  /**
   * Unified diff of a node's most recent change.
   * @param scope - which store to read from.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param id - the memory node id.
   * @returns the diff, with an empty `diff` when the node was created exactly once.
   * @throws when the node has no history (does not exist).
   */
  async diff(scope: MemoryScope, workspace: string | undefined, id: string): Promise<NodeDiff> {
    const dir = await this.resolveStore(scope, workspace)
    const entries = await this.timelineAt(dir, nodePath(id))
    if (entries.length === 0) throw new Error(`memory: no memory "${id}" to diff`)
    if (entries.length < 2) return { id, diff: '' }
    const previous = entries[1]
    if (previous === undefined) return { id, diff: '' }
    const diff = await this.git.diffFile(dir, nodePath(id), previous.revision, 'HEAD')
    return { id, diff: diff ?? '' }
  }

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
  async revert(
    scope: MemoryScope,
    workspace: string | undefined,
    id: string,
    revision: string,
  ): Promise<MemoryWriteResult> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const relPath = nodePath(id)
      const content = await this.git.showFile(dir, revision, relPath)
      if (content === undefined) {
        throw new Error(`memory: revision "${revision}" does not contain "${id}"`)
      }
      await writeUtf8(join(dir, relPath), content)
      await this.git.commit(dir, `memory: revert ${id} to ${revision.slice(0, 12)}`)
      return {
        node: { id, title: firstHeading(content) ?? id, content: stripHeading(content), scope, branch: 'default' },
        timeline: await this.timeline(scope, workspace, id),
      }
    })
  }

  /**
   * Collect the existing memory stores along `workspace`'s ancestor chain,
   * nearest first, ending at the filesystem root. Levels without a store are
   * skipped and NEVER created — chain reads must not materialize stores.
   * @param workspace - the directory whose ancestor chain to walk.
   * @returns absolute store directories (`<dir>/.dsh-memory`), nearest first.
   */
  async ancestorStores(workspace: string): Promise<string[]> {
    const fs = await import('node:fs/promises')
    const stores: string[] = []
    let dir = resolve(workspace)
    for (;;) {
      const candidate = join(dir, '.dsh-memory')
      try {
        if ((await fs.stat(candidate)).isDirectory()) stores.push(candidate)
      } catch {
        // no store at this level
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return stores
  }

  /**
   * List the memory node ids of the complete inheritance chain: every existing
   * store along `workspace`'s ancestor directories, nearest first, followed by
   * the central (global) store when it has content.
   * @param workspace - the directory whose ancestor chain to walk.
   * @returns one entry per existing, committed store on the chain.
   */
  async listChain(workspace: string): Promise<ChainStore[]> {
    const chain: ChainStore[] = []
    for (const store of await this.ancestorStores(workspace)) {
      if (!(await this.storeHasCommits(store))) continue
      chain.push({ store, ids: await this.listMarkdownIds(store) })
    }
    if (await this.storeHasCommits(this.centralRoot)) {
      chain.push({ store: this.centralRoot, ids: await this.listMarkdownIds(this.centralRoot) })
    }
    return chain
  }

  /**
   * Load every memory node of the complete inheritance chain — the injection
   * view: ancestor-directory stores nearest first, then the central store.
   * @param workspace - the directory whose ancestor chain to walk.
   * @returns one entry per existing, committed store with its full nodes.
   */
  async loadChain(workspace: string): Promise<ChainContent[]> {
    const chain: ChainContent[] = []
    for (const store of await this.ancestorStores(workspace)) {
      if (!(await this.storeHasCommits(store))) continue
      chain.push({ store, scope: 'workspace', nodes: await this.loadStoreNodes(store, 'workspace') })
    }
    if (await this.storeHasCommits(this.centralRoot)) {
      chain.push({ store: this.centralRoot, scope: 'central', nodes: await this.loadStoreNodes(this.centralRoot, 'central') })
    }
    return chain
  }

  /**
   * Read one node from the complete inheritance chain, nearest store first,
   * falling back to the central store.
   * @param workspace - the directory whose ancestor chain to walk.
   * @param id - the memory node id.
   * @returns the node, its timeline, and the store that held it; undefined when absent everywhere.
   */
  async readChain(
    workspace: string,
    id: string,
  ): Promise<{ node: MemoryNode; timeline: MemoryTimelineEntry[]; store: string } | undefined> {
    const relPath = nodePath(id)
    for (const store of await this.ancestorStores(workspace)) {
      const found = await this.readNodeAt(store, relPath, id, 'workspace')
      if (found !== undefined) return found
    }
    if (await this.storeHasCommits(this.centralRoot)) {
      return this.readNodeAt(this.centralRoot, relPath, id, 'central')
    }
    return undefined
  }

  /** Whether a store directory exists and holds at least one commit. */
  private async storeHasCommits(dir: string): Promise<boolean> {
    const fs = await import('node:fs/promises')
    try {
      if (!(await fs.stat(dir)).isDirectory()) return false
    } catch {
      return false
    }
    return this.git.hasCommits(dir)
  }

  /** Read every node of one store. */
  private async loadStoreNodes(store: string, scope: MemoryScope): Promise<MemoryNode[]> {
    const nodes: MemoryNode[] = []
    for (const id of await this.listMarkdownIds(store)) {
      const content = await this.git.readFile(store, nodePath(id))
      if (content === undefined) continue
      nodes.push({ id, title: firstHeading(content) ?? id, content: stripHeading(content), scope, branch: 'default' })
    }
    return nodes
  }

  /** Read one node inside an already-resolved store, or undefined when absent. */
  private async readNodeAt(
    store: string,
    relPath: string,
    id: string,
    scope: MemoryScope,
  ): Promise<{ node: MemoryNode; timeline: MemoryTimelineEntry[]; store: string } | undefined> {
    const content = await this.git.readFile(store, relPath)
    if (content === undefined) return undefined
    const title = firstHeading(content) ?? id
    return {
      node: { id, title, content: stripHeading(content), scope, branch: 'default' },
      timeline: await this.timelineAt(store, relPath),
      store,
    }
  }

  /** One node's change history inside an already-resolved store. */
  private async timelineAt(store: string, relPath: string): Promise<MemoryTimelineEntry[]> {
    const history = await this.git.logFile(store, relPath)
    return history.map((entry, index) => ({
      revision: entry.revision,
      at: entry.at,
      action: index === history.length - 1 ? 'created' : 'updated',
      message: entry.message,
    }))
  }

  /** Resolve the git store directory for a scope, creating and initializing it when absent. */
  private async resolveStore(scope: MemoryScope, workspace: string | undefined): Promise<string> {
    const dir = this.storeDir(scope, workspace)
    await this.git.ensureRepo(dir)
    return dir
  }

  /** Resolve the git store directory for a scope. */
  private storeDir(scope: MemoryScope, workspace: string | undefined): string {
    if (scope === 'central') return this.centralRoot
    if (workspace === undefined || workspace === '') {
      throw new Error('memory: a workspace path is required for the workspace store')
    }
    return join(workspace, '.dsh-memory')
  }

  /** Read store-relative `*.md` node ids recursively; `.git` internals and README.md never count. */
  private async listMarkdownIds(dir: string): Promise<string[]> {
    const fs = await import('node:fs/promises')
    const walk = async (relative: string): Promise<string[]> => {
      const found: string[] = []
      let names: string[]
      try {
        names = await fs.readdir(join(dir, relative))
      } catch {
        return found
      }
      for (const name of names) {
        const rel = relative === '' ? name : `${relative}/${name}`
        const info = await fs.stat(join(dir, rel)).catch(() => undefined)
        if (info === undefined) continue
        if (info.isDirectory()) {
          if (name === '.git') continue
          found.push(...await walk(rel))
        } else if (name.endsWith('.md') && name !== 'README.md') {
          found.push(rel.slice(0, -3))
        }
      }
      return found
    }
    return (await walk('')).sort()
  }

  /**
   * Create a branch from the current HEAD and switch to it — the start of a
   * parallel conclusion line (e.g. two approaches explored at once).
   * @param scope - which store to branch.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param name - the new branch name, in the format `task-x/attempt-a`.
   * @throws when `name` violates the branch-name format.
   */
  async branch(scope: MemoryScope, workspace: string | undefined, name: string): Promise<{ branch: string }> {
    const error = branchNameError(name)
    if (error !== undefined) throw new Error(error)
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      await this.git.createBranch(dir, name)
      return { branch: name }
    })
  }

  /** Switch to an existing branch. */
  async checkout(scope: MemoryScope, workspace: string | undefined, name: string): Promise<{ branch: string }> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      await this.git.checkoutBranch(dir, name)
      return { branch: name }
    })
  }

  /** The current branch name of a store. */
  async currentBranch(scope: MemoryScope, workspace: string | undefined): Promise<string | undefined> {
    const dir = await this.resolveStore(scope, workspace)
    return this.git.currentBranch(dir)
  }

  /** Every branch of a store, sorted. */
  async listBranches(scope: MemoryScope, workspace: string | undefined): Promise<string[]> {
    const dir = await this.resolveStore(scope, workspace)
    return this.git.listBranches(dir)
  }

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
   */
  async merge(
    scope: MemoryScope,
    workspace: string | undefined,
    from: string,
    strategy?: 'ours' | 'theirs',
  ): Promise<MergeResult> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const headBefore = await this.git.revParseHead(dir)
      const clean = await this.git.startMerge(dir, from, strategy)
      if (clean) {
        await this.git.commit(dir, `memory: merge branch ${from}`)
        const changed = headBefore === undefined ? [] : await this.git.diffFiles(dir, headBefore, 'HEAD')
        const merged = changed
          .filter(path => path.endsWith('.md'))
          .map(path => path.slice(0, -3))
        return { merged, conflicts: [] }
      }
      const conflicts: MergeConflict[] = []
      for (const relPath of await this.git.conflictedFiles(dir)) {
        const id = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath
        const toContent = await this.git.showFile(dir, 'HEAD', relPath)
        const fromContent = await this.git.showFile(dir, from, relPath)
        conflicts.push({ id, toContent: toContent ?? '', fromContent: fromContent ?? '' })
      }
      await this.git.abortMerge(dir)
      return { merged: [], conflicts }
    })
  }

  /**
   * Permanently delete a node from a store, committed so the removal is
   * recorded and revertable through git history.
   * @param scope - which store to remove from.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param id - the memory node id.
   * @throws when the node does not exist.
   */
  async remove(scope: MemoryScope, workspace: string | undefined, id: string): Promise<void> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const relPath = nodePath(id)
      if (await this.git.readFile(dir, relPath) === undefined) {
        throw new Error(`memory: no memory "${id}" to remove`)
      }
      const fs = await import('node:fs/promises')
      await fs.rm(join(dir, relPath))
      await this.git.commit(dir, `memory: remove ${id}`)
    })
  }

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
  async archive(scope: MemoryScope, workspace: string | undefined, id: string): Promise<{ id: string }> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const relPath = nodePath(id)
      if (await this.git.readFile(dir, relPath) === undefined) {
        throw new Error(`memory: no memory "${id}" to archive`)
      }
      const archivedId = `archive/${id}`
      const fs = await import('node:fs/promises')
      await fs.mkdir(dirname(join(dir, nodePath(archivedId))), { recursive: true })
      await fs.rename(join(dir, relPath), join(dir, nodePath(archivedId)))
      await this.git.commit(dir, `memory: archive ${id}`)
      return { id: archivedId }
    })
  }

  /**
   * Restore an archived node back to its original id, committed. Accepts the
   * archived id (`archive/<id>`) or the bare original id.
   * @param scope - which store to restore in.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @param id - the archived (or original) node id.
   * @returns the restored id.
   * @throws when no archived node exists for that id.
   */
  async unarchive(scope: MemoryScope, workspace: string | undefined, id: string): Promise<{ id: string }> {
    return serializeWrite(async () => {
      const dir = await this.resolveStore(scope, workspace)
      const archived = id.startsWith('archive/') ? id : `archive/${id}`
      const relPath = nodePath(archived)
      if (await this.git.readFile(dir, relPath) === undefined) {
        throw new Error(`memory: no archived memory "${id}" to restore`)
      }
      const original = archived.slice('archive/'.length)
      const fs = await import('node:fs/promises')
      await fs.mkdir(dirname(join(dir, nodePath(original))), { recursive: true })
      await fs.rename(join(dir, relPath), join(dir, nodePath(original)))
      await this.git.commit(dir, `memory: unarchive ${original}`)
      return { id: original }
    })
  }
}

/**
 * Map a memory id to its store-relative path. A `/`-separated id becomes a
 * nested path (`bugfix/alpha` → `bugfix/alpha.md`); every segment must be
 * non-empty and free of path traversal, separators, and filesystem-hostile
 * characters.
 */
function nodePath(id: string): string {
  if (id.length === 0 || id !== id.trim() || /[\\<>:"|?*\u0000-\u001f]/.test(id)) {
    throw new Error(`memory: invalid id "${id}"`)
  }
  if (id.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`memory: invalid id "${id}"`)
  }
  return `${id}.md`
}

/** Write a UTF-8 file at `path`, creating parent directories. */
async function writeUtf8(path: string, content: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(await import('node:path').then(m => m.dirname(path)), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

/** Read the first `# ` heading of a memory body, when present. */
function firstHeading(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content)
  return match?.[1]?.trim()
}

/** Strip the leading `# title` line from a body for the machine-readable title field. */
function stripHeading(content: string): string {
  return content.replace(/^#\s+.+$/m, '').trim()
}

export default MemoryService
