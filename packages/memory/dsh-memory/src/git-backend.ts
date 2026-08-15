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
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'

/** Buffer cap for collected git output — commit/log output is small. */
const MAX_OUTPUT_BYTES = 64 * 1024

/** How many times a git call colliding on `index.lock` is retried, with backoff. */
const INDEX_LOCK_RETRIES = 3

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
   * Ensure a directory exists as its own git repository, initializing it if
   * needed. The store must own its repository: probing "am I inside a work
   * tree" would answer true for a store nested inside an unrelated repository
   * and silently route every git operation at the outer repo.
   * @param dir - the memory store directory.
   */
  async ensureRepo(dir: string): Promise<void> {
    await this.mkdirRecursive(dir)
    const fs = await import('node:fs/promises')
    let owned = false
    try {
      owned = (await fs.stat(join(dir, '.git'))).isDirectory()
    } catch {
      // no .git yet: the store is not a repository
    }
    if (!owned) await this.git(dir, ['init'])
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
   * Read the full change history of one store-relative file, newest first.
   *
   * The format uses NUL as the field separator (`%H%x00%cI%x00%s%x00`) so a
   * commit message containing newlines cannot break record parsing; each
   * commit contributes exactly three fields: hash, ISO-8601 commit date,
   * subject.
   * @param dir - the memory store directory.
   * @param relPath - store-relative path to trace.
   * @returns one entry per commit that touched the file, newest first; empty
   *   when the file has no history.
   */
  async logFile(dir: string, relPath: string): Promise<Array<{ revision: string; at: string; message: string }>> {
    // `--follow` keeps the trace across renames, so a memory moved into a
    // hierarchy directory keeps its pre-move history.
    const result = await this.git(dir, ['log', '--follow', '--format=%H%x00%cI%x00%s%x00', '--', relPath])
    if (result.code !== 0 || result.stdout === '') return []
    // Git emits one record per line (`hash NUL time NUL message NUL` then a
    // newline); splitting the whole buffer on NUL would fold the newline into
    // the next record's hash, so records are split on `\n` first and NUL
    // fields within each line.
    const entries: Array<{ revision: string; at: string; message: string }> = []
    for (const line of result.stdout.split('\n')) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line
      if (clean === '') continue
      const fields = clean.split('\0')
      const revision = fields[0]
      const at = fields[1]
      const message = fields[2]
      if (revision !== undefined && at !== undefined && message !== undefined) {
        entries.push({ revision, at, message })
      }
    }
    return entries
  }

  /**
   * Create a branch from the current HEAD and switch to it.
   * @param dir - the memory store directory.
   * @param name - the new branch name.
   */
  async createBranch(dir: string, name: string): Promise<void> {
    const result = await this.git(dir, ['checkout', '-b', name])
    if (result.code !== 0) throw new Error(`memory git branch failed: ${result.stderr}`)
  }

  /**
   * Switch to an existing branch.
   * @param dir - the memory store directory.
   * @param name - the branch name.
   */
  async checkoutBranch(dir: string, name: string): Promise<void> {
    const result = await this.git(dir, ['checkout', name])
    if (result.code !== 0) throw new Error(`memory git checkout failed: ${result.stderr}`)
  }

  /**
   * The current branch name.
   * @param dir - the memory store directory.
   * @returns the branch name, or undefined on a detached/unborn HEAD.
   */
  async currentBranch(dir: string): Promise<string | undefined> {
    const result = await this.git(dir, ['branch', '--show-current'])
    const name = result.stdout.trim()
    return name === '' ? undefined : name
  }

  /** Every branch name, sorted. */
  async listBranches(dir: string): Promise<string[]> {
    const result = await this.git(dir, ['branch', '--format=%(refname:short)'])
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '').sort()
  }

  /** The current HEAD commit hash, or undefined for an unborn HEAD. */
  async revParseHead(dir: string): Promise<string | undefined> {
    const result = await this.git(dir, ['rev-parse', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() || undefined : undefined
  }

  /**
   * Start a merge of `from` into the current branch without committing.
   * Identity is inlined like {@link commit}: stores never carry global git
   * config, and merge still requires a committer identity. An optional
   * conflict strategy makes git resolve conflicts in favor of the current
   * branch (`ours`) or the merged branch (`theirs`) instead of failing.
   * @param dir - the memory store directory.
   * @param from - the branch to merge in.
   * @param strategy - conflict resolution strategy, when given.
   * @returns whether the merge is clean (no conflicts).
   */
  async startMerge(dir: string, from: string, strategy?: 'ours' | 'theirs'): Promise<boolean> {
    const args = [
      '-c', 'user.name=rin', '-c', 'user.email=rin@localhost',
      'merge', '--no-commit', '--no-ff',
      ...strategy === undefined ? [] : ['-X', strategy],
      from,
    ]
    const result = await this.git(dir, args)
    return result.code === 0
  }

  /**
   * Store-relative paths of files with merge conflicts (empty when none).
   */
  async conflictedFiles(dir: string): Promise<string[]> {
    const result = await this.git(dir, ['diff', '--name-only', '--diff-filter=U'])
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /** Store-relative paths changed between two revisions. */
  async diffFiles(dir: string, fromRev: string, toRev: string): Promise<string[]> {
    const result = await this.git(dir, ['diff', '--name-only', `${fromRev}..${toRev}`])
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /**
   * Unified diff text of one store-relative file between two revisions.
   * @param dir - the memory store directory.
   * @param relPath - store-relative path.
   * @param fromRev - the older revision.
   * @param toRev - the newer revision.
   * @returns the diff text, or undefined when git reports no diff.
   */
  async diffFile(dir: string, relPath: string, fromRev: string, toRev: string): Promise<string | undefined> {
    const result = await this.git(dir, ['diff', `${fromRev}..${toRev}`, '--', relPath])
    return result.code === 0 ? result.stdout : undefined
  }

  /** Abort an in-progress merge, restoring the pre-merge working tree. */
  async abortMerge(dir: string): Promise<void> {
    await this.git(dir, ['merge', '--abort'])
  }

  /**
   * Read one file as of a revision/branch.
   * @param dir - the memory store directory.
   * @param rev - a revision or branch name.
   * @param relPath - store-relative path.
   * @returns the content, or undefined when absent at that revision.
   */
  async showFile(dir: string, rev: string, relPath: string): Promise<string | undefined> {
    const result = await this.git(dir, ['show', `${rev}:${relPath}`])
    return result.code === 0 ? result.stdout : undefined
  }

  /**
   * Case-insensitive fixed-string search over the store's tracked `*.md`
   * files. The pattern is passed via `-e`, so a query starting with `-`
   * cannot be read as an option.
   * @param dir - the memory store directory.
   * @param query - the literal text to find.
   * @returns matching lines in `path:lineno:line` form, unsorted.
   */
  async grep(dir: string, query: string): Promise<string[]> {
    const result = await this.git(dir, ['grep', '-n', '-i', '-F', '-e', query, '--', '*.md'])
    if (result.code !== 0 || result.stdout === '') return []
    return result.stdout.split('\n').filter(line => line !== '')
  }

  /**
   * Run one confined git command in `dir`, collecting bounded stdout and
   * stderr. A call that collides on git's `index.lock` (another process owns
   * the index momentarily) is retried with short backoff — same-process
   * writes are serialized by the service, this covers cross-process races.
   */
  private async git(dir: string, args: readonly string[]): Promise<GitResult> {
    let result = await this.spawnGit(dir, args)
    for (let attempt = 1; attempt <= INDEX_LOCK_RETRIES && isIndexLockCollision(result); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25 * attempt))
      result = await this.spawnGit(dir, args)
    }
    return result
  }

  /** One confined git spawn, without retry. */
  private async spawnGit(dir: string, args: readonly string[]): Promise<GitResult> {
    const value: unknown = this.ctx.get('subprocess')
    const subprocess = value as SubprocessRuntime | undefined
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

/** Whether a failed git call collided on the index lock file. */
function isIndexLockCollision(result: GitResult): boolean {
  return result.code !== 0 && result.stderr.includes('index.lock')
}
