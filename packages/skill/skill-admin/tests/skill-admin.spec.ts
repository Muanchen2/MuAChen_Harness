import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SkillAdminManager } from '../src/manager.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  contexts.push(ctx)
  return ctx
}

function managerOf(ctx: Context, home: string): SkillAdminManager {
  return new SkillAdminManager(ctx, home)
}

describe('SkillAdminManager', () => {
  it('creates a skill with validated frontmatter and commits it', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    const result = await admin.create({
      target: 'user',
      cwd,
      name: 'my-skill',
      description: 'My test skill',
      whenToUse: 'For tests',
      content: 'Do the thing.\n',
    })

    expect(result).toContain('created skill my-skill')
    const skillMd = await readFile(join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('name: my-skill')
    expect(skillMd).toContain('description: My test skill')
    expect(skillMd).toContain('whenToUse: For tests')
    expect(skillMd).toContain('Do the thing.')
    const history = await admin.history({ target: 'user', cwd, name: 'my-skill' })
    expect(history).toContain('create my-skill')
  })

  it('rejects invalid names, missing descriptions, and duplicate creates', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    await expect(admin.create({ target: 'user', cwd, name: 'Bad_Name', description: 'x' }))
      .rejects.toThrow('not a valid kebab-case skill name')
    await expect(admin.create({ target: 'user', cwd, name: 'valid-name', description: '  ' }))
      .rejects.toThrow('non-empty description')
    await admin.create({ target: 'user', cwd, name: 'valid-name', description: 'ok' })
    await expect(admin.create({ target: 'user', cwd, name: 'valid-name', description: 'again' }))
      .rejects.toThrow('already exists')
  })

  it('updates fields while preserving the body and unknown frontmatter', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    await admin.create({
      target: 'user',
      cwd,
      name: 'updatable',
      description: 'Before',
      content: 'Original body',
    })
    await admin.update({
      target: 'user',
      cwd,
      name: 'updatable',
      description: 'After',
      whenToUse: 'Updated guidance',
    })

    const skillMd = await readFile(join(home, 'skills', 'updatable', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('description: After')
    expect(skillMd).toContain('whenToUse: Updated guidance')
    expect(skillMd).toContain('Original body')

    await admin.update({ target: 'user', cwd, name: 'updatable', content: 'Replaced body' })
    const replaced = await readFile(join(home, 'skills', 'updatable', 'SKILL.md'), 'utf8')
    expect(replaced).toContain('Replaced body')
    expect(replaced).not.toContain('Original body')
    expect(replaced).toContain('description: After')
  })

  it('archives into _archived/ and keeps tracing history across the move', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    await admin.create({ target: 'user', cwd, name: 'archivable', description: 'To archive', content: 'v1' })
    await admin.update({ target: 'user', cwd, name: 'archivable', content: 'v2' })
    const historyBefore = await admin.history({ target: 'user', cwd, name: 'archivable' })
    expect(historyBefore.split('\n')).toHaveLength(2)

    const result = await admin.archive({ target: 'user', cwd, name: 'archivable' })
    expect(result).toContain('_archived')
    await expect(stat(join(home, 'skills', 'archivable'))).rejects.toThrow()
    await expect(stat(join(home, 'skills', '_archived', 'archivable', 'SKILL.md'))).resolves.toBeDefined()

    const historyAfter = await admin.history({ target: 'user', cwd, name: 'archivable' })
    // The move commit itself lands on the `--follow` trace: create, update, archive.
    expect(historyAfter.split('\n')).toHaveLength(3)
    expect(historyAfter).toContain('archive archivable')
  })

  it('reverts a skill file to an earlier revision, committed as a new change', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    await admin.create({ target: 'user', cwd, name: 'revertible', description: 'Rev me', content: 'first' })
    await admin.update({ target: 'user', cwd, name: 'revertible', content: 'second' })
    const history = await admin.history({ target: 'user', cwd, name: 'revertible' })
    const newestRevision = history.split('\n')[0]?.split(' ')[0]
    const older = history.split('\n').find(line => !line.startsWith(newestRevision ?? ''))
    const olderRevision = older?.split(' ')[0]
    expect(olderRevision).toBeDefined()

    const result = await admin.revert({ target: 'user', cwd, name: 'revertible', revision: olderRevision! })
    expect(result).toContain(`reverted revertible to ${olderRevision!.slice(0, 12)}`)
    const skillMd = await readFile(join(home, 'skills', 'revertible', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('first')
    expect(skillMd).not.toContain('second')
    const after = await admin.history({ target: 'user', cwd, name: 'revertible' })
    expect(after.split('\n')).toHaveLength(3)
  })

  it('removes a skill and reports the removal through commitChanges', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')

    await admin.create({ target: 'user', cwd, name: 'removable', description: 'Remove me' })
    const result = await admin.remove({ target: 'user', cwd, name: 'removable' })
    expect(result).toContain('removed skill removable')
    await expect(stat(join(home, 'skills', 'removable'))).rejects.toThrow()

    expect(await admin.commitChanges({ target: 'user', cwd })).toContain('nothing to commit')

    const skillMd = join(home, 'skills', 'manual', 'SKILL.md')
    await mkdir(join(home, 'skills', 'manual'), { recursive: true })
    await writeFile(skillMd, '---\nname: manual\ndescription: manual\n---\n\nmanual\n', 'utf8')
    const committed = await admin.commitChanges({ target: 'user', cwd, message: 'manual add' })
    expect(committed).toContain('committed')
    await expect(readFile(skillMd, 'utf8')).resolves.toContain('manual')
  })

  it('promotes a loose script into a script skill', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const cwd = await tempDir('admin-cwd')
    const script = join(cwd, '.tmp', 'gen-report.mjs')
    await mkdir(join(cwd, '.tmp'), { recursive: true })
    await writeFile(script, 'console.log("hi")\n', 'utf8')

    const result = await admin.promote({
      target: 'workspace',
      cwd,
      name: 'gen-report',
      description: 'Generates the report',
      source: '.tmp/gen-report.mjs',
      runtime: 'node',
    })

    expect(result).toContain('promoted')
    const root = join(cwd, '.dsh-skills')
    await expect(readFile(join(root, 'gen-report', 'SKILL.md'), 'utf8')).resolves.toContain('script: gen-report.mjs')
    await expect(readFile(join(root, 'gen-report', 'SKILL.md'), 'utf8')).resolves.toContain('runtime: node')
    await expect(readFile(join(root, 'gen-report', 'gen-report.mjs'), 'utf8')).resolves.toBe('console.log("hi")\n')
  })

  it('resolves the workspace layer to the nearest ancestor .dsh-skills', async () => {
    const home = await tempDir('admin-home')
    const ctx = await setup()
    const admin = managerOf(ctx, home)
    const workspace = await tempDir('admin-ws')
    const nested = join(workspace, 'packages', 'app')
    await mkdir(join(workspace, '.dsh-skills'), { recursive: true })
    await mkdir(nested, { recursive: true })

    await admin.create({ target: 'workspace', cwd: nested, name: 'shared-skill', description: 'Shared' })
    const root = await admin.resolveRoot('workspace', nested)
    expect(root).toBe(join(workspace, '.dsh-skills'))
    await expect(stat(join(root, 'shared-skill', 'SKILL.md'))).resolves.toBeDefined()
  })
})
