/**
 * Skill-admin operations over the git-backed skill stores.
 *
 * Each skill root (`~/.dsh/skills` for the user layer, `<cwd>/.dsh-skills` or
 * the nearest ancestor's for the workspace layer) is its own git repository.
 * Every mutation here writes the working tree and commits it, so a skill's
 * change history is always recorded and `history`/`revert` can address it.
 *
 * @module @deepseek-ai/dsh-skill-admin/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { basename, dirname, join, resolve } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { SkillGitBackend, type SkillGitEntry } from './git-backend.ts'

/** Which skill root an admin action operates on. */
export type SkillAdminTarget = 'user' | 'workspace'

/** Input of a skill write action (create/update/archive/remove/revert/promote). */
export interface SkillAdminInput {
  target: SkillAdminTarget
  cwd: string | undefined
  name: string
  description?: string
  whenToUse?: string
  script?: string
  runtime?: string
  content?: string
  revision?: string
  source?: string
  message?: string
}

/**
 * Serialize one store write across every session sharing this module. Skill
 * stores are host singletons; concurrent writes from parallel sessions would
 * interleave their file writes and `git add -A` staging, so a write (file
 * change plus its commit) must run atomically. Reads stay concurrent.
 */
let writeTail: Promise<void> = Promise.resolve()
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeTail.then(task, task)
  writeTail = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Executes skill-admin write/read operations on the git-backed skill roots.
 * @param ctx - the host context whose `subprocess` service runs git.
 * @param dshHome - resolved `$DSH_HOME`; the user root is `<dshHome>/skills`.
 */
export class SkillAdminManager {
  private readonly git: SkillGitBackend

  constructor(
    _ctx: Context,
    private readonly dshHome: string,
  ) {
    this.git = new SkillGitBackend(_ctx)
  }

  /**
   * Create a new directory-bundle skill: `SKILL.md` with validated frontmatter
   * plus the body, committed. Fails when the skill already exists — update it.
   * @param input - the skill name, target layer, optional frontmatter fields,
   *   and the body.
   * @returns a model-facing summary of what was written.
   */
  async create(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const { root, dir, name } = await this.beginWrite(input, true)
      const description = requireDescription(input)
      const frontmatter = buildFrontmatter({
        name,
        description,
        ...input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {},
        ...input.script !== undefined ? { script: input.script } : {},
        ...input.runtime !== undefined ? { runtime: input.runtime } : {},
      })
      await writeUtf8(join(dir, 'SKILL.md'), renderSkillFile(frontmatter, input.content ?? ''))
      await this.commit(root, input, `create ${name}`)
      return `created skill ${name} at ${dir}`
    })
  }

  /**
   * Update frontmatter fields and/or the body of an existing skill, committed.
   * Fields not provided keep their current values; `content` replaces the body.
   * @param input - the skill name, target layer, and the fields to change.
   * @returns a model-facing summary of what changed.
   */
  async update(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const { root, dir, name } = await this.beginWrite(input, false)
      const skillMd = join(dir, 'SKILL.md')
      const raw = await readUtf8(skillMd)
      const parsed = parseSkillFile(raw)
      if (parsed === undefined) throw new Error(`skill-admin: ${skillMd} has invalid or missing YAML frontmatter`)
      const data: Record<string, unknown> = { ...parsed.data }
      if (input.description !== undefined && input.description.trim() !== '') data.description = input.description.trim()
      if (input.whenToUse !== undefined) data.whenToUse = input.whenToUse
      if (input.script !== undefined) data.script = input.script
      if (input.runtime !== undefined) data.runtime = input.runtime
      const body = input.content ?? parsed.body
      await writeUtf8(skillMd, renderSkillFile(data, body))
      await this.commit(root, input, `update ${name}`)
      return `updated skill ${name} at ${dir}`
    })
  }

  /**
   * Move a skill out of the active catalogue into `<root>/_archived/<name>/`,
   * committed. Discovery ignores underscore-prefixed root entries, so the
   * archived skill disappears from the catalog; `history` still traces it and
   * `revert` restores file content.
   * @param input - the skill name and target layer.
   * @returns a model-facing summary of the move.
   */
  async archive(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const { root, dir, name } = await this.beginWrite(input, false)
      const archived = join(root, '_archived', name)
      const fs = await import('node:fs/promises')
      await fs.rm(archived, { recursive: true, force: true })
      await fs.mkdir(dirname(archived), { recursive: true })
      await fs.rename(dir, archived)
      await this.commit(root, input, `archive ${name}`)
      return `archived skill ${name} to ${archived}`
    })
  }

  /**
   * Delete a skill directory entirely, committed. The removal stays in git
   * history, so the skill can be recovered by reverting a previous revision.
   * @param input - the skill name and target layer.
   * @returns a model-facing summary of the removal.
   */
  async remove(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const { root, dir, name } = await this.beginWrite(input, false)
      const fs = await import('node:fs/promises')
      await fs.rm(dir, { recursive: true, force: true })
      await this.commit(root, input, `remove ${name}`)
      return `removed skill ${name} from ${dir}`
    })
  }

  /**
   * Commit pending working-tree changes of a skill root (for example after the
   * agent edited a SKILL.md with the filesystem tools). Fails when the root is
   * not a repository or nothing is staged.
   * @param input - the target layer and an optional commit message.
   * @returns the new HEAD revision, or "nothing to commit".
   */
  async commitChanges(input: { target: SkillAdminTarget; cwd: string | undefined; message?: string }): Promise<string> {
    return serializeWrite(async () => {
      const root = await this.resolveRoot(input.target, input.cwd)
      await this.git.ensureRepo(root)
      const message = input.message?.trim() ?? 'skill-admin: manual commit'
      const revision = await this.git.commit(root, message)
      return revision === undefined ? `nothing to commit in ${root}` : `committed ${revision.slice(0, 12)} in ${root}`
    })
  }

  /**
   * Show the commit history of one skill's `SKILL.md`, newest first. The trace
   * follows renames, so archived skills keep their full history.
   * @param input - the skill name and target layer.
   * @returns the history lines, or a notice when the skill has no commits.
   */
  async history(input: { target: SkillAdminTarget; cwd: string | undefined; name: string }): Promise<string> {
    const root = await this.resolveRoot(input.target, input.cwd)
    if (!(await this.git.hasCommits(root))) return `no history for ${input.name}: ${root} has no commits`
    const relPath = await this.locateSkillMd(root, input.name)
    if (relPath === undefined) return `no history for ${input.name}: skill not found in ${root}`
    const entries = await this.git.logFile(root, relPath)
    if (entries.length === 0) return `no history for ${input.name} (${relPath})`
    return formatHistory(entries)
  }

  /**
   * Restore a skill's `SKILL.md` from an earlier revision, committed as a new
   * change. The revert lands on the history, so nothing is ever lost.
   * @param input - the skill name, target layer, and the revision to restore
   *   (take it from `history`).
   * @returns a model-facing summary of the restore.
   */
  async revert(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const name = validateName(input.name)
      if (input.revision === undefined || input.revision === '') {
        throw new Error('skill-admin: revert requires a revision (take it from history)')
      }
      const root = await this.resolveRoot(input.target, input.cwd)
      await this.git.ensureRepo(root)
      const relPath = await this.locateSkillMd(root, name)
      if (relPath === undefined) throw new Error(`skill-admin: no skill "${name}" in ${root}`)
      const content = await this.git.showFile(root, input.revision, relPath)
      if (content === undefined) {
        throw new Error(`skill-admin: revision "${input.revision}" does not contain ${relPath}`)
      }
      await writeUtf8(join(root, dirname(relPath), 'SKILL.md'), content)
      const message = input.message?.trim() ?? `skill-admin: revert ${name} to ${input.revision.slice(0, 12)}`
      await this.git.commit(root, message)
      return `reverted ${name} to ${input.revision.slice(0, 12)}`
    })
  }

  /**
   * Promote a loose script into a proper directory-bundle skill: the script is
   * copied into `<root>/<name>/` and a `SKILL.md` with `script`/`runtime`
   * frontmatter is generated, committed. The agent decides the promotion
   * trigger (reuse across 2+ tasks, or the owner naming it) before calling.
   * @param input - the skill name, target layer, description, the source
   *   script path, and optional whenToUse/runtime.
   * @returns a model-facing summary of the promotion.
   */
  async promote(input: SkillAdminInput): Promise<string> {
    return serializeWrite(async () => {
      const { root, dir, name } = await this.beginWrite(input, true)
      const description = requireDescription(input)
      if (input.source === undefined || input.source === '') {
        throw new Error('skill-admin: promote requires a source script path')
      }
      const source = resolve(input.cwd ?? process.cwd(), input.source)
      const fs = await import('node:fs/promises')
      const scriptText = await fs.readFile(source, 'utf8')
      if (scriptText.includes('\uFFFD')) {
        throw new Error(`skill-admin: ${source} is not a text file`)
      }
      const scriptName = basename(source)
      const frontmatter = buildFrontmatter({
        name,
        description,
        ...input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {},
        script: scriptName,
        ...input.runtime !== undefined ? { runtime: input.runtime } : {},
      })
      await writeUtf8(join(dir, scriptName), scriptText)
      await writeUtf8(join(dir, 'SKILL.md'), renderSkillFile(frontmatter, input.content ?? ''))
      await this.commit(root, input, `promote ${name}`)
      return `promoted ${source} to skill ${name} at ${dir}`
    })
  }

  /** Resolve the skill root for a target layer, creating the workspace root when absent. */
  async resolveRoot(target: SkillAdminTarget, cwd: string | undefined): Promise<string> {
    if (target === 'user') return join(this.dshHome, 'skills')
    if (cwd === undefined || cwd === '') {
      throw new Error('skill-admin: a workspace path is required for the workspace layer')
    }
    return nearestAncestorSkillRoot(cwd)
  }

  /**
   * Resolve the root, ensure it is a git repository, and locate the skill
   * directory. `create` requires the skill to be absent; every other write
   * requires it to be present in the active tree.
   */
  private async beginWrite(
    input: SkillAdminInput,
    create: boolean,
  ): Promise<{ root: string; dir: string; name: string }> {
    const name = validateName(input.name)
    const root = await this.resolveRoot(input.target, input.cwd)
    await this.git.ensureRepo(root)
    const dir = join(root, name)
    const fs = await import('node:fs/promises')
    const exists = await fs.stat(dir).then(info => info.isDirectory()).catch(() => false)
    if (create && exists) throw new Error(`skill-admin: skill "${name}" already exists in ${root} — use update`)
    if (!create && !exists) throw new Error(`skill-admin: no skill "${name}" in ${root}`)
    return { root, dir, name }
  }

  /** Commit a completed write with the per-action default message. */
  private async commit(root: string, input: SkillAdminInput, action: string): Promise<string | undefined> {
    const message = input.message?.trim() ?? `skill-admin: ${action}`
    return this.git.commit(root, message)
  }

  /** Root-relative `SKILL.md` path of a skill, active or archived; undefined when absent. */
  private async locateSkillMd(root: string, name: string): Promise<string | undefined> {
    const fs = await import('node:fs/promises')
    for (const relPath of [join(name, 'SKILL.md'), join('_archived', name, 'SKILL.md')]) {
      const found = await fs.stat(join(root, relPath)).then(info => info.isFile()).catch(() => false)
      if (found) return relPath
    }
    return undefined
  }
}

/** Validate a kebab-case skill name and return it trimmed. */
function validateName(name: string): string {
  const trimmed = name.trim()
  if (!isSkillName(trimmed)) {
    throw new Error(`skill-admin: "${name}" is not a valid kebab-case skill name`)
  }
  return trimmed
}

/** Validate and return the required non-empty description. */
function requireDescription(input: SkillAdminInput): string {
  const description = input.description?.trim()
  if (description === undefined || description === '') {
    throw new Error('skill-admin: a non-empty description is required')
  }
  return description
}

/** Build the frontmatter data map, omitting unset optional fields. */
function buildFrontmatter(input: {
  name: string
  description: string
  whenToUse?: string
  script?: string
  runtime?: string
}): Record<string, unknown> {
  const data: Record<string, unknown> = { name: input.name, description: input.description }
  if (input.whenToUse !== undefined && input.whenToUse.trim() !== '') data.whenToUse = input.whenToUse.trim()
  if (input.script !== undefined && input.script.trim() !== '') data.script = input.script.trim()
  if (input.runtime !== undefined && input.runtime.trim() !== '') data.runtime = input.runtime.trim()
  return data
}

/** Render a full SKILL.md from frontmatter data plus a body. */
function renderSkillFile(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd()
  const trimmedBody = body.trim()
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`
}

/** Parse a SKILL.md into frontmatter data and body; undefined on malformed input. */
function parseSkillFile(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const yaml = raw.slice(start, lineStart)
      const parsed = parseYaml(yaml) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1
      return { data: parsed as Record<string, unknown>, body: raw.slice(bodyStart) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** Find the nearest `.dsh-skills` ancestor of `cwd`; fall back to `cwd/.dsh-skills`. */
async function nearestAncestorSkillRoot(cwd: string): Promise<string> {
  const fs = await import('node:fs/promises')
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, '.dsh-skills')
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate
    } catch {
      // no skill root at this level
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(resolve(cwd), '.dsh-skills')
}

/** Write a UTF-8 file at `path`, creating parent directories. */
async function writeUtf8(path: string, content: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

/** Read a UTF-8 file; throws when absent. */
async function readUtf8(path: string): Promise<string> {
  const fs = await import('node:fs/promises')
  return await fs.readFile(path, 'utf8')
}

/** Render history entries into model-facing lines. */
function formatHistory(entries: SkillGitEntry[]): string {
  return entries.map(entry => `${entry.revision.slice(0, 12)}  ${entry.at}  ${entry.message}`).join('\n')
}
