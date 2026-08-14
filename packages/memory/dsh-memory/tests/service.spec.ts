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

  it('stores and lists hierarchical ids as nested paths', async () => {
    const root = tempRoot('hierarchy')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    await memories.remember('workspace', workspace, {
      id: 'bugfix/enoent', title: 'Fix ENOENT', content: 'nested under bugfix',
    })
    await memories.remember('workspace', workspace, {
      id: 'feature/context-injection', title: 'Context injection', content: 'nested under feature',
    })
    await memories.remember('workspace', workspace, {
      id: 'flat', title: 'Flat', content: 'stays at the store root',
    })

    expect(await memories.list('workspace', workspace)).toEqual([
      'bugfix/enoent', 'feature/context-injection', 'flat',
    ])
    const found = await memories.read('workspace', workspace, 'bugfix/enoent')
    expect(found?.node.content).toBe('nested under bugfix')
    const timeline = await memories.timeline('workspace', workspace, 'feature/context-injection')
    expect(timeline.at(0)?.action).toBe('created')
  })

  it('scans nested directories recursively and ignores .git and README.md', async () => {
    const root = tempRoot('recursive')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    await memories.remember('workspace', workspace, { id: 'a/deep/nested', title: 'Deep', content: 'x' })
    const store = join(workspace, '.dsh-memory')
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(store, 'README.md'), '# store notes\n', 'utf8')
    await fs.writeFile(join(store, 'a', 'README.md'), '# dir notes\n', 'utf8')
    await fs.writeFile(join(store, '.git', 'fake.md'), 'not a memory\n', 'utf8')

    expect(await memories.list('workspace', workspace)).toEqual(['a/deep/nested'])
  })

  it('rejects ids with traversal, absolute, trailing, empty, or backslash segments', async () => {
    const root = tempRoot('invalid-ids')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))

    for (const id of ['..', '../escape', 'a/../b', '/absolute', 'trailing/', 'a//b', 'a\\b', '', ' spaced ']) {
      await expect(memories.remember('workspace', workspace, { id, title: 'Bad', content: 'x' }))
        .rejects.toThrow(`memory: invalid id "${id}"`)
    }
  })

  it('walks the ancestor chain: nearest first, skipping and never creating absent levels', async () => {
    const root = tempRoot('chain')
    const a = join(root, 'a')
    const b = join(a, 'b')
    const c = join(b, 'c')
    const { memories } = await service(join(root, 'central'))

    // only the top level and the deepest level have stores; `b` has none
    await memories.remember('workspace', a, { id: 'parent-note', title: 'Parent', content: 'a-level' })
    await memories.remember('workspace', c, { id: 'leaf-note', title: 'Leaf', content: 'c-level' })
    await memories.remember('central', undefined, { id: 'global', title: 'Global', content: 'central-level' })

    const stores = await memories.ancestorStores(c)
    expect(stores).toEqual([join(c, '.dsh-memory'), join(a, '.dsh-memory')])
    // a chain read must not materialize the missing middle store
    expect(await import('node:fs/promises').then(m => m.stat(join(b, '.dsh-memory'))).catch(() => undefined))
      .toBeUndefined()

    // the chain ends with the central (global) store
    const chain = await memories.listChain(c)
    expect(chain.map(entry => entry.ids)).toEqual([['leaf-note'], ['parent-note'], ['global']])
    expect(chain.at(-1)?.store).toBe(join(root, 'central'))

    const loaded = await memories.loadChain(c)
    expect(loaded.map(entry => entry.nodes.map(node => node.id))).toEqual([['leaf-note'], ['parent-note'], ['global']])
    expect(loaded.at(-1)?.scope).toBe('central')

    // nearest store wins; the central store is the final fallback
    const found = await memories.readChain(c, 'parent-note')
    expect(found?.store).toBe(join(a, '.dsh-memory'))
    expect(found?.node.content).toBe('a-level')
    const global = await memories.readChain(c, 'global')
    expect(global?.store).toBe(join(root, 'central'))
    expect(global?.node.scope).toBe('central')
    expect(await memories.readChain(c, 'absent')).toBeUndefined()
  })

  it('branches, lists, and switches branches of a store', async () => {
    const root = tempRoot('branches')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'v1' })

    await memories.branch('workspace', workspace, 'attempt-a')
    expect(await memories.currentBranch('workspace', workspace)).toBe('attempt-a')
    await memories.remember('workspace', workspace, { id: 'beta', title: 'Beta', content: 'on attempt-a' })

    await memories.checkout('workspace', workspace, 'master')
    expect(await memories.currentBranch('workspace', workspace)).toBe('master')
    expect(await memories.read('workspace', workspace, 'beta')).toBeUndefined()

    expect(await memories.listBranches('workspace', workspace)).toEqual(['attempt-a', 'master'])
  })

  it('rejects branch names that violate the naming rule, before touching git', async () => {
    const root = tempRoot('branch-guard')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'v1' })

    for (const bad of ['Task-x', 'task_x', 'task x', 'task.x', '任务', '-x', 'x-', '/x', 'x/', 'x//y', '']) {
      await expect(memories.branch('workspace', workspace, bad)).rejects.toThrow(/memory:branch name/)
      expect(await memories.currentBranch('workspace', workspace)).toBe('master')
    }

    await memories.branch('workspace', workspace, 'task-x/attempt-a')
    expect(await memories.currentBranch('workspace', workspace)).toBe('task-x/attempt-a')
  })

  it('merges a branch cleanly and reports the brought-in nodes', async () => {
    const root = tempRoot('merge-clean')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'base' })

    await memories.branch('workspace', workspace, 'feature-x')
    await memories.remember('workspace', workspace, { id: 'feature/n', title: 'N', content: 'only on the branch' })

    await memories.checkout('workspace', workspace, 'master')
    const result = await memories.merge('workspace', workspace, 'feature-x')
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual(['feature/n'])
    expect((await memories.read('workspace', workspace, 'feature/n'))?.node.content).toBe('only on the branch')
  })

  it('rolls back a conflicting merge, reports both sides, and merges after reconciliation', async () => {
    const root = tempRoot('merge-conflict')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'initial' })

    await memories.branch('workspace', workspace, 'attempt-a')
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'approach A conclusion' })

    await memories.checkout('workspace', workspace, 'master')
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'mainline conclusion' })

    const result = await memories.merge('workspace', workspace, 'attempt-a')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.id).toBe('design/x')
    expect(result.conflicts[0]?.toContent).toContain('mainline conclusion')
    expect(result.conflicts[0]?.fromContent).toContain('approach A conclusion')
    // the merge was rolled back: the mainline still holds its own version
    expect((await memories.read('workspace', workspace, 'design/x'))?.node.content).toBe('mainline conclusion')

    // reconcile by updating the target node, then retry keeping the reconciled mainline version
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'combined: A refined by mainline' })
    const retry = await memories.merge('workspace', workspace, 'attempt-a', 'ours')
    expect(retry.conflicts).toEqual([])
    expect((await memories.read('workspace', workspace, 'design/x'))?.node.content).toBe('combined: A refined by mainline')
  })

  it('resolves a conflict in favor of the merged branch with the theirs strategy', async () => {
    const root = tempRoot('merge-theirs')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'initial' })

    await memories.branch('workspace', workspace, 'attempt-a')
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'approach A conclusion' })

    await memories.checkout('workspace', workspace, 'master')
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'mainline conclusion' })

    const result = await memories.merge('workspace', workspace, 'attempt-a', 'theirs')
    expect(result.conflicts).toEqual([])
    expect(result.merged).toEqual(['design/x'])
    expect((await memories.read('workspace', workspace, 'design/x'))?.node.content).toBe('approach A conclusion')
  })
})
