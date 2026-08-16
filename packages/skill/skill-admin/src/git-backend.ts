/**
 * Git-backed store for Rin skill roots.
 *
 * A skill root is a directory kept under git. Git supplies the recorded,
 * revertable change history the admin tool needs: every write action commits,
 * `history` traces a skill file across commits (including renames into the
 * `_archived/` tree), and `revert` restores a file from an old revision.
 * Skills evolve on a single line — no branches, no merges.
 *
 * Git runs through `ctx.subprocess` (never raw `node:child_process`), so spawn
 * is confined the same way every other harness subprocess is.
 *
 * @module @deepseek-ai/dsh-skill-admin/git-backend
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

/** One commit that touched a tracked skill file. */
export interface SkillGitEntry {
  readonly revision: string
  readonly at: string
  readonly message: string
}

/**
 * Backend that runs git in a skill root directory through `ctx.subprocess`.
 * @param ctx - the host context whose `subprocess` service runs git.
 */
export class SkillGitBackend {
  constructor(private readonly ctx: Context) {}

  /**
   * Ensure a directory exists as its own git repository, initializing it if
   * needed. The root must own its repository: probing "am I inside a work
   * tree" would answer true for a root nested inside an unrelated repository
   * and silently route every git operation at the outer repo.
   * @param dir - the skill root directory.
   */
  async ensureRepo(dir: string): Promise<void> {
    await mkdirRecursive(dir)
    const fs = await import('node:fs/promises')
    let owned = false
    try {
      owned = (await fs.stat(join(dir, '.git'))).isDirectory()
    } catch {
      // no .git yet: the root is not a repository
    }
    if (!owned) await this.git(dir, ['init'])
  }

  /**
   * Whether the root has at least one commit yet.
   * @param dir - the skill root directory.
   * @returns true when HEAD resolves, false when there are no commits.
   */
  async hasCommits(dir: string): Promise<boolean> {
    const result = await this.git(dir, ['rev-parse', 'HEAD'])
    return result.code === 0 && result.stdout.trim() !== ''
  }

  /**
   * Commit the full working-tree change of one skill root. Nothing staged is
   * not an error: callers report "nothing to commit" instead.
   * @param dir - the skill root directory.
   * @param commitMessage - the commit message.
   * @returns the new HEAD revision, or undefined when nothing was staged.
   */
  async commit(dir: string, commitMessage: string): Promise<string | undefined> {
    const staged = await this.git(dir, ['add', '-A'])
    if (staged.code !== 0) throw new Error(`skill git add failed: ${staged.stderr}`)
    const changed = await this.git(dir, ['status', '--porcelain'])
    if (changed.stdout.trim() === '') return undefined
    await this.git(dir, ['-c', 'user.name=rin', '-c', 'user.email=rin@localhost', 'commit', '-q', '-m', commitMessage])
    const rev = await this.git(dir, ['rev-parse', 'HEAD'])
    return rev.stdout.trim() || undefined
  }

  /**
   * Read the full change history of one root-relative skill file, newest first.
   *
   * The format uses NUL as the field separator (`%H%x00%cI%x00%s%x00`) so a
   * commit message containing newlines cannot break record parsing.
   * @param dir - the skill root directory.
   * @param relPath - root-relative path to trace.
   * @returns one entry per commit that touched the file, newest first; empty
   *   when the file has no history.
   */
  async logFile(dir: string, relPath: string): Promise<SkillGitEntry[]> {
    // `--follow` keeps the trace across renames, so a skill moved into the
    // `_archived/` tree keeps its pre-move history (and the move commit itself
    // appears on the trace).
    const result = await this.git(dir, ['log', '--follow', '--format=%H%x00%cI%x00%s%x00', '--', gitPath(relPath)])
    if (result.code !== 0 || result.stdout === '') return []
    const entries: SkillGitEntry[] = []
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
   * Read one file as of a revision.
   * @param dir - the skill root directory.
   * @param rev - a revision or branch name.
   * @param relPath - root-relative path.
   * @returns the content, or undefined when absent at that revision.
   */
  async showFile(dir: string, rev: string, relPath: string): Promise<string | undefined> {
    const result = await this.git(dir, ['show', `${rev}:${gitPath(relPath)}`])
    return result.code === 0 ? result.stdout : undefined
  }

  /**
   * Run one confined git command in `dir`, collecting bounded stdout and
   * stderr. A call that collides on git's `index.lock` is retried with short
   * backoff — same-process writes are serialized by the manager, this covers
   * cross-process races.
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
      throw new Error('skill-admin: the subprocess service is required to run git')
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
}

/** Create `dir` and every missing ancestor. */
async function mkdirRecursive(dir: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Normalize a host path to git's forward-slash convention. `git log` pathspecs
 * tolerate `\` on Windows, but `git show rev:path` treats it as a literal
 * character, so every repository-relative path is converted before use.
 */
function gitPath(relPath: string): string {
  return relPath.replaceAll('\\', '/')
}

/** Whether a failed git call collided on the index lock file. */
function isIndexLockCollision(result: GitResult): boolean {
  return result.code !== 0 && result.stderr.includes('index.lock')
}
