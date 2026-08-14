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
import { join } from 'node:path'
import { GitBackend } from './git-backend.ts'
import type { MemoryNode, MemoryScope, MemoryTimelineEntry, MemoryWriteResult } from './types.ts'

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
    const dir = this.storeDir(scope, workspace)
    await this.git.ensureRepo(dir)
    const relPath = nodePath(input.id)
    await writeUtf8(join(dir, relPath), `# ${input.title}\n\n${input.content}\n`)
    await this.git.commit(dir, input.message ?? `memory: ${input.title}`)
    return {
      node: { id: input.id, title: input.title, content: input.content, scope, branch: 'default' },
      timeline: await this.timeline(scope, workspace, input.id),
    }
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
    const dir = this.storeDir(scope, workspace)
    if (!(await this.git.hasCommits(dir))) return undefined
    const content = await this.git.readFile(dir, nodePath(id))
    if (content === undefined) return undefined
    const title = firstHeading(content) ?? id
    return { node: { id, title, content: stripHeading(content), scope, branch: 'default' }, timeline: await this.timeline(scope, workspace, id) }
  }

  /**
   * List the current memory node ids in a store.
   * @param scope - which store to scan.
   * @param workspace - workspace path (used only for `scope: 'workspace'`).
   * @returns the sorted list of node ids (`*.md` basenames in the store root).
   */
  async list(scope: MemoryScope, workspace: string | undefined): Promise<string[]> {
    const dir = this.storeDir(scope, workspace)
    if (!(await this.git.hasCommits(dir))) return []
    return this.listMarkdownIds(dir)
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
    const dir = this.storeDir(scope, workspace)
    const history = await this.git.logFile(dir, nodePath(id))
    return history.map((entry, index) => ({
      revision: entry.revision,
      at: entry.at,
      action: index === history.length - 1 ? 'created' : 'updated',
      message: entry.message,
    }))
  }

  /** Resolve the git store directory for a scope. */
  private storeDir(scope: MemoryScope, workspace: string | undefined): string {
    if (scope === 'central') return this.centralRoot
    if (workspace === undefined || workspace === '') {
      throw new Error('memory: a workspace path is required for the workspace store')
    }
    return join(workspace, '.dsh-memory')
  }

  /** Read store-root `*.md` basenames (strip the extension) as node ids. */
  private async listMarkdownIds(dir: string): Promise<string[]> {
    const fs = await import('node:fs/promises')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }
    return entries
      .filter(name => name.endsWith('.md') && name !== 'README.md')
      .map(name => name.slice(0, -3))
      .sort()
  }
}

/** Map a memory id to its store-relative path. An id becomes the basename. */
function nodePath(id: string): string {
  if (id.length === 0 || id !== id.trim() || /\.\.|[/\\]/.test(id)) {
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
