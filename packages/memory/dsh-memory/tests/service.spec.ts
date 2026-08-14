import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import MemoryService from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-memory-${label}-`))
  roots.push(root)
  return root
}

async function service(centralRoot: string): Promise<{ ctx: Context; memories: MemoryService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(MemoryService, { centralRoot })
  return { ctx, memories: ctx.memories }
}

/** Create a committed git repository at `dir` with an unrelated committed file. */
async function committedRepo(ctx: Context, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const run = async (...args: string[]): Promise<void> => {
    const handle = ctx.subprocess.spawn({
      argv: ['git', ...args],
      cwd: dir,
      stdio: { stdin: { data: '' }, stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 30_000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${String(outcome.exitCode)}`)
  }
  await run('init')
  await run('config', 'user.name', 'tester')
  await run('config', 'user.email', 'tester@localhost')
  await run('commit', '--allow-empty', '-m', 'outer baseline')
}

describe('the memory service over a git-backed store', () => {
  it('keeps a store nested inside an unrelated repository fully owned and readable', async () => {
    const root = tempRoot('nested')
    const outer = join(root, 'outer')
    const { ctx, memories } = await service(join(root, 'central'))
    await committedRepo(ctx, outer)

    const result = await memories.remember('workspace', outer, {
      id: 'nested-note',
      title: 'Nested note',
      content: 'experience recorded beside an unrelated repository',
      message: 'write nested note',
    })
    expect(result.node.id).toBe('nested-note')

    // The store owns its repository: the outer repo's HEAD and index must not
    // grow the memory file, and the store directory must carry its own .git.
    const trackedHandle = ctx.subprocess.spawn({
      argv: ['git', 'ls-files'],
      cwd: outer,
      stdio: { stdin: { data: '' }, stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 30_000,
    })
    const tracked = (await trackedHandle.done).exitCode === 0
      ? trackedHandle.collected.stdout?.readFrom(0).text ?? ''
      : ''
    expect(tracked).not.toContain('.dsh-memory')
    const storeGitDir = join(outer, '.dsh-memory', '.git')
    expect(await import('node:fs/promises').then(m => m.stat(storeGitDir)).then(s => s.isDirectory())).toBe(true)

    const found = await memories.read('workspace', outer, 'nested-note')
    expect(found?.node.content).toBe('experience recorded beside an unrelated repository')
    const timeline = await memories.timeline('workspace', outer, 'nested-note')
    expect(timeline.at(0)?.message).toBe('write nested note')
  })

  it('records, reads, lists, and timelines nodes in a standalone workspace', async () => {
    const root = tempRoot('standalone')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    await memories.remember('workspace', workspace, {
      id: 'alpha',
      title: 'Alpha',
      content: 'first experience',
      message: 'add alpha',
    })
    await memories.remember('workspace', workspace, {
      id: 'beta',
      title: 'Beta',
      content: 'second experience',
      message: 'add beta',
    })

    expect(await memories.list('workspace', workspace)).toEqual(['alpha', 'beta'])
    const found = await memories.read('workspace', workspace, 'beta')
    expect(found?.node.title).toBe('Beta')
    expect(found?.node.content).toBe('second experience')
    expect(found?.timeline.at(0)?.message).toBe('add beta')
  })

  it('returns the complete change history of a node, newest first', async () => {
    const root = tempRoot('history')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    await memories.remember('workspace', workspace, {
      id: 'note',
      title: 'Note',
      content: 'v1',
      message: 'create note',
    })
    await memories.remember('workspace', workspace, {
      id: 'note',
      title: 'Note',
      content: 'v2',
      message: 'update to v2',
    })
    await memories.remember('workspace', workspace, {
      id: 'note',
      title: 'Note',
      content: 'v3',
      message: 'update to v3',
    })

    const timeline = await memories.timeline('workspace', workspace, 'note')
    expect(timeline).toHaveLength(3)
    expect(timeline[0]?.action).toBe('updated')
    expect(timeline[0]?.message).toBe('update to v3')
    expect(timeline[0]?.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(timeline[1]?.action).toBe('updated')
    expect(timeline[1]?.message).toBe('update to v2')
    expect(timeline[2]?.action).toBe('created')
    expect(timeline[2]?.message).toBe('create note')
    // every entry carries a distinct revision
    const revisions = new Set(timeline.map(entry => entry.revision))
    expect(revisions.size).toBe(3)
    // a node never touched has no history
    expect(await memories.timeline('workspace', workspace, 'absent')).toEqual([])
  })

  it('serves the central store without a workspace path', async () => {
    const root = tempRoot('central')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('central', undefined, {
      id: 'shared',
      title: 'Shared',
      content: 'cross-project knowledge',
    })
    const found = await memories.read('central', undefined, 'shared')
    expect(found?.node.content).toBe('cross-project knowledge')
  })

  it('returns undefined when reading a missing id', async () => {
    const root = tempRoot('missing')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', join(root, 'ws'), { id: 'present', title: 'Present', content: 'x' })
    expect(await memories.read('workspace', join(root, 'ws'), 'absent')).toBeUndefined()
  })

  it('lists, reads, and timelines an absent store as empty and initializes it', async () => {
    const root = tempRoot('absent-store')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    expect(await memories.list('workspace', workspace)).toEqual([])
    expect(await memories.read('workspace', workspace, 'anything')).toBeUndefined()
    expect(await memories.timeline('workspace', workspace, 'anything')).toEqual([])
    expect(await memories.list('central', undefined)).toEqual([])
    expect(await memories.read('central', undefined, 'anything')).toBeUndefined()
    // the first touch creates the store as its own git repository, ready for a write
    const storeGitDir = join(workspace, '.dsh-memory', '.git')
    expect(await import('node:fs/promises').then(m => m.stat(storeGitDir)).then(s => s.isDirectory())).toBe(true)
  })

  it('rejects a workspace-scoped operation without a workspace path', async () => {
    const root = tempRoot('nopath')
    const { memories } = await service(join(root, 'central'))
    await expect(memories.list('workspace', undefined)).rejects.toThrow(
      'memory: a workspace path is required for the workspace store',
    )
  })
})
