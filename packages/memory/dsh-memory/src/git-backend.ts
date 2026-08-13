/**
 * Git-backed store for Rin memory.
 *
 * A memory store is a directory kept under git. Git supplies exactly what a
 * project-experience memory needs and skills do not: a recorded, revertable
 * change history (each write is a commit), branches for strategy variants and
 * research forks, and subtree sharing for cross-session shared knowledge. This
 * backend has no notion of memory semantics; the {@link MemoryService} layers
 * memory-node structure and timeline on top of these git primitives.
 *
 * Git runs through `ctx.subprocess` (never raw `node:child_process`), so spawn
 * is confined the same way every other harness subprocess is.
 *
 * @module @deepseek-ai/dsh-memory/git-backend
 */

import type { Context } from '@deepseek-ai/cordis'

/** Buffer cap for collected git output — commit/log output is small. */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * One captured git invocation result.
 * @param code - process exit code (null only for a signal kill).
 * @param stdout - collected stdout tail.
 * @param stderr - collected stderr tail.
 */
export interface GitResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Backend that runs git in a store directory through `ctx.subprocess`.
 * @param ctx - the host context whose `subprocess` service runs git.
 */
export class GitBackend {
  constructor(private readonly ctx: Context) {}

  /**
   * Ensure a directory exists as a git repository, initializing it if needed.
   * @param dir - the memory store directory.
   * @returns the already-collected result of init/revparse, so callers can predicate on it.
   */
  async ensureRepo(dir: string): Promise<void> {
    await this.mkdirRecursive(dir)
    await this.git(dir, ['rev-parse', '--is-inside-work-tree'])
      .then((result) => {
        if (result.code === 0 && result.stdout.trim() === 'true') return
        return this.git(dir, ['init'])
      })
  }

  /**
   * Whether the store has at least one commit yet.
   * @param dir - the memory store directory.
   * @returns true when HEAD resolves, false when there are no commits.
   */
  async hasCommits(dir: string): Promise<boolean> {
    const result = await this.git(dir, ['rev-parse', 'HEAD'])
    return result.code === 0 && result.stdout.trim() !== ''
  }

  /**
   * Read a file's current content from the working tree.
   * @param dir - the memory store directory.
   * @param relPath - store-relative path.
   * @returns the file content, or undefined when absent.
   */
  async readFile(dir: string, relPath: string): Promise<string | undefined> {
    const statResult = await this.git(dir, ['cat-file', '-e', `HEAD:${relPath}`])
    if (statResult.code !== 0) return undefined
    const result = await this.git(dir, ['show', `HEAD:${relPath}`])
    return result.code === 0 ? result.stdout : undefined
  }

  /**
   * Commit a working-tree change for one memory node.
   * @param dir - the memory store directory.
   * @param commitMessage - the commit message (the timeline note).
   * @returns the new HEAD revision, or undefined when nothing was staged.
   */
  async commit(dir: string, commitMessage: string): Promise<string | undefined> {
    const staged = await this.git(dir, ['add', '-A'])
    if (staged.code !== 0) throw new Error(`memory git add failed: ${staged.stderr}`)
    const changed = await this.git(dir, ['status', '--porcelain'])
    if (changed.stdout.trim() === '') return undefined
    await this.git(dir, ['-c', 'user.name=rin', '-c', 'user.email=rin@localhost', 'commit', '-q', '-m', commitMessage])
    const rev = await this.git(dir, ['rev-parse', 'HEAD'])
    return rev.stdout.trim() || undefined
  }

  /**
   * Read the last commit message and date on the current branch, when any.
   * @param dir - the memory store directory.
   * @returns `{ message, at }` or undefined.
   */
  async lastCommit(dir: string): Promise<{ message: string; at: string } | undefined> {
    const result = await this.git(dir, ['log', '-1', '--format=%s%n%cI', 'HEAD'])
    if (result.code !== 0 || result.stdout.trim() === '') return undefined
    const [message, at] = result.stdout.trim().split('\n')
    if (message === undefined) return undefined
    return { message, at: at ?? new Date(0).toISOString() }
  }

  /** Run one confined git command in `dir`, collecting bounded stdout and stderr. */
  private async git(dir: string, args: readonly string[]): Promise<GitResult> {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('memory: the subprocess service is required to run git')
    }
    const handle = subprocess.spawn({
      argv: ['git', ...args],
      cwd: dir,
      stdio: {
        stdin: { data: '' },
        stdout: { maxBytes: MAX_OUTPUT_BYTES },
        stderr: { maxBytes: MAX_OUTPUT_BYTES },
      },
      graceMs: 30_000,
    })
    const outcome = await handle.done
    const readAll = (reader: { readFrom(offset: number): { text: string } } | undefined): string =>
      reader === undefined ? '' : reader.readFrom(0).text
    return {
      code: outcome.exitCode,
      stdout: readAll(handle.collected.stdout),
      stderr: readAll(handle.collected.stderr),
    }
  }

  /** Create `dir` and every missing ancestor. */
  private async mkdirRecursive(dir: string): Promise<void> {
    const fs = await import('node:fs/promises')
    await fs.mkdir(dir, { recursive: true })
  }
}
