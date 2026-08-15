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

  it('removes a node permanently while keeping its history', async () => {
    const root = tempRoot('remove-node')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v1' })
    await memories.remember('workspace', workspace, { id: 'keep/me', title: 'Keep', content: 'v1' })

    await memories.remove('workspace', workspace, 'design/x')

    expect(await memories.read('workspace', workspace, 'design/x')).toBeUndefined()
    expect(await memories.list('workspace', workspace)).toEqual(['keep/me'])
    // the removal itself is a committed, revertable change
    expect((await memories.timeline('workspace', workspace, 'design/x')).map(entry => entry.message))
      .toContain('memory: remove design/x')
  })

  it('removing a missing node throws without touching the store', async () => {
    const root = tempRoot('remove-missing')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'v1' })
    await expect(memories.remove('workspace', workspace, 'nope')).rejects.toThrow(/no memory "nope" to remove/)
    expect(await memories.list('workspace', workspace)).toEqual(['alpha'])
  })

  it('archives a node out of the active listing and restores it on unarchive', async () => {
    const root = tempRoot('archive-node')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'superseded' })

    const archived = await memories.archive('workspace', workspace, 'design/x')
    expect(archived.id).toBe('archive/design/x')
    // hidden from the active catalogue, still readable and listed under the prefix
    expect(await memories.list('workspace', workspace)).toEqual([])
    expect(await memories.list('workspace', workspace, 'archive/')).toEqual(['archive/design/x'])
    expect((await memories.read('workspace', workspace, 'archive/design/x'))?.node.content).toBe('superseded')
    // timeline survives the move
    expect((await memories.timeline('workspace', workspace, 'archive/design/x')).length).toBeGreaterThan(0)

    const restored = await memories.unarchive('workspace', workspace, 'archive/design/x')
    expect(restored.id).toBe('design/x')
    expect(await memories.list('workspace', workspace)).toEqual(['design/x'])
    expect((await memories.read('workspace', workspace, 'design/x'))?.node.content).toBe('superseded')
  })

  it('unarchive accepts the bare id and rejects missing archives', async () => {
    const root = tempRoot('unarchive-missing')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v1' })
    await memories.archive('workspace', workspace, 'design/x')

    await expect(memories.unarchive('workspace', workspace, 'nope')).rejects.toThrow(/no archived memory "nope" to restore/)
    expect((await memories.unarchive('workspace', workspace, 'design/x')).id).toBe('design/x')
    expect(await memories.read('workspace', workspace, 'design/x')).toBeDefined()
  })

  it('serializes concurrent writes so every write lands as its own commit', async () => {
    const root = tempRoot('concurrent-writes')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      memories.remember('workspace', workspace, { id: `concurrent/n${index}`, title: `N${index}`, content: 'v1' })))

    expect(await memories.list('workspace', workspace)).toHaveLength(8)
    // each node's earliest commit must carry its own message; without the
    // write lock, interleaved `git add -A` staging would fold nodes into one
    // another's commits and this fails.
    for (let index = 0; index < 8; index++) {
      const timeline = await memories.timeline('workspace', workspace, `concurrent/n${index}`)
      expect(timeline.at(-1)?.message).toBe(`memory: N${index}`)
    }
  })

  it('retries a git call that collides on index.lock', async () => {
    const root = tempRoot('index-lock-retry')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await service(join(root, 'central'))
    const originalSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let collisions = 0
    ctx.subprocess.spawn = ((options: Parameters<typeof originalSpawn>[0]) => {
      if (collisions < 2) {
        collisions += 1
        return {
          done: Promise.resolve({ exitCode: 128 }),
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: "fatal: Unable to create '.../.git/index.lock': File exists." }) },
          },
        } as unknown as ReturnType<typeof originalSpawn>
      }
      return originalSpawn(options)
    })

    await memories.remember('workspace', workspace, { id: 'retry/me', title: 'Retry', content: 'v1' })

    expect(collisions).toBe(2)
    expect((await memories.read('workspace', workspace, 'retry/me'))?.node.content).toBe('v1')
  })

  it('diffs the most recent change of a node', async () => {
    const root = tempRoot('diff-node')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v1' })
    expect((await memories.diff('workspace', workspace, 'design/x')).diff).toBe('')

    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v2' })
    const result = await memories.diff('workspace', workspace, 'design/x')
    expect(result.diff).toContain('-v1')
    expect(result.diff).toContain('+v2')

    await expect(memories.diff('workspace', workspace, 'nope')).rejects.toThrow(/no memory "nope" to diff/)
  })

  it('reverts a node to a previous revision, keeping the revert on the timeline', async () => {
    const root = tempRoot('revert-node')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v1' })
    await memories.remember('workspace', workspace, { id: 'design/x', title: 'X', content: 'v2 bad' })
    const v1Revision = (await memories.timeline('workspace', workspace, 'design/x')).at(-1)?.revision
    expect(v1Revision).toBeDefined()

    const reverted = await memories.revert('workspace', workspace, 'design/x', v1Revision!)
    expect(reverted.node.content).toBe('v1')
    expect(reverted.timeline[0]?.message).toBe(`memory: revert design/x to ${v1Revision!.slice(0, 12)}`)
    // the revert itself is a new change; the history is never lost
    expect(reverted.timeline).toHaveLength(3)

    await expect(memories.revert('workspace', workspace, 'design/x', '0000000000000000000000000000000000000000'))
      .rejects.toThrow(/revision .* does not contain "design\/x"/)
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

  it('searches node bodies case-insensitively and ranks by match count', async () => {
    const root = tempRoot('search-basic')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'store 目录缺失导致 spawn 失败' })
    await memories.remember('workspace', workspace, { id: 'env/git', title: 'git 用法', content: 'git commit 需要身份。\nspawn 走 ctx.subprocess。\nspawn 失败要重试。' })

    const hits = await memories.search('workspace', workspace, 'spawn')
    expect(hits.map(hit => hit.id)).toEqual(['env/git', 'bugfix/enoent'])
    expect(hits[0]?.matchCount).toBeGreaterThan(hits[1]?.matchCount ?? 0)
    expect(hits[1]?.title).toBe('修复 ENOENT')

    expect(await memories.search('workspace', workspace, 'SPAWN')).toHaveLength(2)
    expect(await memories.search('workspace', workspace, '不存在的内容xyz')).toEqual([])
    expect(await memories.search('workspace', workspace, '')).toEqual([])
  })

  it('excludes archived nodes from search results', async () => {
    const root = tempRoot('search-archive')
    const workspace = join(root, 'ws')
    const { memories } = await service(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/old', title: '旧方案', content: 'spawn 相关旧结论' })
    await memories.remember('workspace', workspace, { id: 'design/new', title: '新方案', content: 'spawn 相关现行结论' })
    await memories.archive('workspace', workspace, 'design/old')

    const hits = await memories.search('workspace', workspace, 'spawn')
    expect(hits.map(hit => hit.id)).toEqual(['design/new'])
  })

  it('searches the ancestor chain and the central store', async () => {
    const root = tempRoot('search-chain')
    const a = join(root, 'a')
    const b = join(a, 'b')
    const central = join(root, 'central')
    const { memories } = await service(central)
    await memories.remember('workspace', a, { id: 'parent/topic', title: 'Parent', content: 'parent level spawn note' })
    await memories.remember('workspace', b, { id: 'leaf/topic', title: 'Leaf', content: 'leaf level spawn note' })
    await memories.remember('central', undefined, { id: 'shared/topic', title: 'Shared', content: 'central spawn note' })

    const chain = await memories.searchChain(b, 'spawn')
    expect(chain.map(entry => entry.store)).toEqual([
      join(b, '.dsh-memory'),
      join(a, '.dsh-memory'),
      central,
    ])
    expect(chain[0]?.hits[0]?.id).toBe('leaf/topic')
    expect(chain[2]?.hits[0]?.id).toBe('shared/topic')
  })
})
