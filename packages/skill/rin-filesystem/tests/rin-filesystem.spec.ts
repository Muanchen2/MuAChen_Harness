import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as RinFileSystem from '../src/index.ts'
import { describe, expect, it } from 'vitest'

async function tempDir(label: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-rin-skill-${label}-`)))
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

describe('dsh-rin-skill-filesystem', () => {
  it('registers the fixed Rin provider and inherits nearest roots', async () => {
    const home = await tempDir('home')
    const workspace = await tempDir('workspace')
    const nested = join(workspace, 'packages/app')
    await mkdir(join(workspace, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeSkill(join(workspace, '.dsh-skills'), 'shared', 'Workspace', 'workspace body')
    await writeSkill(join(nested, '.dsh-skills'), 'shared', 'Nested', 'nested body')
    await writeSkill(join(home, '.dsh/skills'), 'global', 'Global', 'global body')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(RinFileSystem, { dshHome: join(home, '.dsh'), watch: false })

    expect((await ctx.skills.list({ cwd: nested })).map(skill => skill.name)).toEqual(['global', 'shared'])
    expect((await ctx.skills.get('shared', { cwd: nested }))?.content).toBe('nested body')
    expect((await ctx.skills.get('shared', { cwd: nested }))?.provider).toBe('rin-filesystem')
  })
})
