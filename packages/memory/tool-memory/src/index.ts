/**
 * Model-facing `memory` tool over the Rin memory service.
 *
 * Distinct from `skill`: skills are methods (how), memories are experience
 * (what happened / current state) that must survive across sessions. The tool
 * lets the agent record, read, list, and inspect the timeline of memory nodes,
 * scoped to the current workspace or the central store.
 *
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { MemoryService } from '@deepseek-ai/dsh-memory'
import { branchNameError } from '@deepseek-ai/dsh-memory'

/** Which store a memory lives in; mirrors `@deepseek-ai/dsh-memory`'s scope. */
export type MemoryScope = 'workspace' | 'central'

export const name = 'tool-memory'
export const inject = ['tools', 'memories', 'systemPrompt']

/** Tool configuration. */
export interface Config {
  /** Where the system-prompt guidance section appears. */
  sectionOrder?: number
}

export const Config: Schema<Config> = z.object({
  sectionOrder: z.number().default(115),
})

const MEMORY_GUIDANCE = '使用 memory 工具持久化与回顾跨会话的项目经验，区别于 skills（方法）：'
  + 'skills 存"怎么做"，memory 存"发生了什么、结论、当前状态"。记忆存储在 git 底座的 Rin 仓库：'
  + 'workspace 作用域存于当前项目旁，central 作用域跨项目共享；每个会话的第一轮会自动注入相关记忆目录，'
  + '因此现在记录的经验在未来会话中自动可见。开始长任务前，先用 memory list/read 回顾相关记忆，'
  + '恢复之前的结论与状态。**会话开始时，若注入的记忆目录里有 handoff/ 交接单（未完成任务），'
  + '主动用 memory read 读取并衔接继续，不要等用户提醒。**写入前先查重：用 memory list 查看是否已有'
  + '同主题记忆；有则用相同 id 更新（保留演进历史），避免同主题散成多条互相矛盾的记忆。在达成有意义'
  + '的结论后立即 remember：修好了一个 bug、做出了架构决策、解决了一个坑、学到了环境或工具路径、'
  + '或者改变了立场。**并行探索多个方案时，用 memory branch 开分支（如 task-x/attempt-a）分别记录，'
  + '分支名只允许小写字母、数字、连字符，多级用 / 分隔（如 task-x/attempt-a，不允许大写、下划线、'
  + '空格或中文）；方案确认后用 memory merge 合并回主线；merge 冲突时先 read 两边内容，整合成综合'
  + '结论更新到目标节点后再重试。**任务未完成需要交接时，写 handoff/<任务名> 交接单（结构：目标/进度/'
  + '下一步/遗留坑/相关文件），**交接单默认存 workspace（项目工作区），不要写入 central**——central 只用于'
  + '一次性跨项目传递，任务完成或承接方接手后立即归档；任务完成后把交接单标题改为含"已完成"并归档。'
  + '**记忆维护：被推翻或过时的结论用 memory archive 归档（移入 archive/，'
  + '不再注入和列出，可 memory read archive/<id> 或 memory list archive/ 找回，memory unarchive 恢复）；'
  + '误写、测试或临时记录用 memory remove 彻底删除（git 历史仍可追溯）；写错的内容用 memory diff 查看'
  + '最近变更、memory revert <id> 配合 timeline 里的 revision 恢复到历史版本。记忆保持事实性与简洁；'
  + '可复用的方法存入 skills，经验存入 memory。'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
    },
  } as const,
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
}

/** Register the `memory` tool and its policy guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: config.sectionOrder ?? 115,
    text: MEMORY_GUIDANCE,
  })

  ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Persist or recall cross-session project experience (memory), distinct from skills (methods).',
    parameters: {
      action: { type: 'string', required: true, enum: ['remember', 'read', 'list', 'search', 'timeline', 'diff', 'revert', 'branch', 'checkout', 'current-branch', 'list-branches', 'merge', 'remove', 'archive', 'unarchive'] },
      scope: { type: 'string', required: true, enum: ['workspace', 'central', 'chain'] },
      id: { type: 'string', description: 'Memory node id for read/timeline, or the id to save under for remember.' },
      query: { type: 'string', description: 'Full-text search query for memory search (case-insensitive literal match over node bodies).' },
      revision: { type: 'string', description: 'Git revision to restore for revert (take it from timeline output).' },
      title: { type: 'string', description: 'Title for remember; the new memory heading.' },
      content: { type: 'string', description: 'Body for remember; the experience to persist.' },
      message: { type: 'string', description: 'Optional one-line commit note for this change.' },
      strategy: { type: 'string', description: 'Conflict resolution for merge: ours (keep target) or theirs (keep merged).' },
      prefix: { type: 'string', description: 'Optional id prefix filter for list (e.g. archive/ to browse the archive, handoff/ for handoff memos).' },
    },
    output: OUTPUT,
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      return renderMemory(ctx.memories, cwd, args).then(text => ({ text }))
    },
    presentCall: args => ({ card: 'generic' as const, title: `memory:${args.action}`, kind: 'other' as const, rawInput: args.id ?? args.title }),
  }))
}

/** Dispatch one memory action to the service and shape the model-visible result. */
async function renderMemory(
  memories: MemoryService,
  cwd: string | undefined,
  args: { action: string; scope: 'workspace' | 'central' | 'chain'; id?: string; query?: string; revision?: string; title?: string; content?: string; message?: string; strategy?: string; prefix?: string },
): Promise<string> {
  const scope = args.scope
  const workspace = scope === 'workspace' ? cwd : undefined
  /** Narrow the scope for branch operations: chain has no branchable store. */
  const branchScope = (): MemoryScope | { error: string } =>
    scope === 'chain' ? { error: 'memory:branch operations require workspace or central scope' } : scope
  /** Narrow the scope for per-store read/write operations that need one concrete store. */
  const storeScope = (): MemoryScope | { error: string } =>
    scope === 'chain' ? { error: 'memory:this action requires workspace or central scope' } : scope
  switch (args.action) {
    case 'branch': {
      const target = branchScope()
      if (typeof target !== 'string') return target.error
      if (args.id === undefined) return 'memory:branch requires a branch name (id)'
      const nameError = branchNameError(args.id)
      if (nameError !== undefined) return nameError
      const result = await memories.branch(target, workspace, args.id)
      return `switched to branch ${result.branch}`
    }
    case 'checkout': {
      const target = branchScope()
      if (typeof target !== 'string') return target.error
      if (args.id === undefined) return 'memory:checkout requires a branch name (id)'
      const result = await memories.checkout(target, workspace, args.id)
      return `switched to branch ${result.branch}`
    }
    case 'current-branch': {
      const target = branchScope()
      if (typeof target !== 'string') return target.error
      const branch = await memories.currentBranch(target, workspace)
      return branch === undefined ? 'no branch (unborn or detached HEAD)' : branch
    }
    case 'list-branches': {
      const target = branchScope()
      if (typeof target !== 'string') return target.error
      const branches = await memories.listBranches(target, workspace)
      return branches.length === 0 ? 'no branches' : branches.join('\n')
    }
    case 'merge': {
      const target = branchScope()
      if (typeof target !== 'string') return target.error
      if (args.id === undefined) return 'memory:merge requires the branch to merge (id)'
      const strategy = args.strategy === 'ours' || args.strategy === 'theirs' ? args.strategy : undefined
      const result = await memories.merge(target, workspace, args.id, strategy)
      if (result.conflicts.length > 0) {
        const lines = ['merge rolled back due to conflicts:']
        for (const conflict of result.conflicts) {
          lines.push(`- ${conflict.id}`)
          lines.push(`  target: ${conflict.toContent.replace(/\n/g, ' ').slice(0, 160)}`)
          lines.push(`  merged: ${conflict.fromContent.replace(/\n/g, ' ').slice(0, 160)}`)
        }
        lines.push('reconcile each conflict (e.g. update the target node with a combined conclusion), then retry merge')
        return lines.join('\n')
      }
      return result.merged.length === 0
        ? `merged branch ${args.id} (nothing new)`
        : `merged branch ${args.id}:\n${result.merged.join('\n')}`
    }
    case 'remember': {
      if (scope === 'chain') return 'memory:remember requires workspace or central scope'
      const id = args.id ?? slug(args.title) ?? `memory-${Date.now()}`
      const title = args.title ?? id
      const content = args.content ?? ''
      const result = await memories.remember(scope, workspace, {
        id, title, content, ...args.message === undefined ? {} : { message: args.message },
      })
      const text = renderNode(result.node, result.timeline)
      const similar = similarIds(await memories.list(scope, workspace), id)
      return similar.length === 0
        ? text
        : `${text}\n\n同目录下已有记忆（同主题请用相同 id 更新而非新建）：\n${similar.map(s => `- ${s}`).join('\n')}`
    }
    case 'read': {
      if (args.id === undefined) return 'memory:read requires an id'
      if (scope === 'chain') {
        if (cwd === undefined) return 'memory:chain requires a session workspace'
        const found = await memories.readChain(cwd, args.id)
        return found === undefined
          ? `no memory "${args.id}" on the ancestor chain`
          : `store: ${found.store}\n${renderNode(found.node, found.timeline)}`
      }
      const found = await memories.read(scope, workspace, args.id)
      return found === undefined ? `no memory "${args.id}" in ${scope} store` : renderNode(found.node, found.timeline)
    }
    case 'list': {
      if (scope === 'chain') {
        if (cwd === undefined) return 'memory:chain requires a session workspace'
        const chain = await memories.listChain(cwd)
        if (chain.length === 0) return 'no memories on the ancestor chain'
        return chain.map(entry => `${entry.store}\n${entry.ids.join('\n')}`).join('\n\n')
      }
      const ids = await memories.list(scope, workspace, args.prefix)
      return ids.length === 0 ? `no memories in ${scope} store` : ids.join('\n')
    }
    case 'search': {
      if (args.query === undefined || args.query === '') return 'memory:search requires a query'
      if (scope === 'chain') {
        if (cwd === undefined) return 'memory:chain requires a session workspace'
        const chain = await memories.searchChain(cwd, args.query)
        if (chain.length === 0) return `no memories matching "${args.query}" on the ancestor chain`
        return chain.map(entry => `${entry.store}\n${renderHits(entry.hits)}`).join('\n\n')
      }
      const hits = await memories.search(scope, workspace, args.query)
      return hits.length === 0
        ? `no memories matching "${args.query}" in ${scope} store`
        : renderHits(hits)
    }
    case 'remove': {
      if (scope === 'chain') return 'memory:remove requires workspace or central scope'
      if (args.id === undefined) return 'memory:remove requires an id'
      await memories.remove(scope, workspace, args.id)
      return `removed memory ${args.id}`
    }
    case 'archive': {
      if (scope === 'chain') return 'memory:archive requires workspace or central scope'
      if (args.id === undefined) return 'memory:archive requires an id'
      const result = await memories.archive(scope, workspace, args.id)
      return `archived memory ${args.id} as ${result.id} (hidden from listings; use memory read ${result.id} or memory list archive/ to see it again)`
    }
    case 'unarchive': {
      if (scope === 'chain') return 'memory:unarchive requires workspace or central scope'
      if (args.id === undefined) return 'memory:unarchive requires an id'
      const result = await memories.unarchive(scope, workspace, args.id)
      return `restored memory ${args.id} to ${result.id}`
    }
    case 'timeline': {
      if (args.id === undefined) return 'memory:timeline requires an id'
      if (scope === 'chain') {
        if (cwd === undefined) return 'memory:chain requires a session workspace'
        const found = await memories.readChain(cwd, args.id)
        return found === undefined
          ? `no timeline for memory "${args.id}"`
          : found.timeline.map(entry => `${entry.at} ${entry.action} ${entry.revision} ${entry.message}`).join('\n')
      }
      const timeline = await memories.timeline(scope, workspace, args.id)
      return timeline.length === 0
        ? `no timeline for memory "${args.id}"`
        : timeline.map(entry => `${entry.at} ${entry.action} ${entry.revision} ${entry.message}`).join('\n')
    }
    case 'diff': {
      const target = storeScope()
      if (typeof target !== 'string') return target.error
      if (args.id === undefined) return 'memory:diff requires an id'
      const result = await memories.diff(target, workspace, args.id)
      return result.diff === ''
        ? `memory ${args.id}: created once, nothing to diff`
        : `diff of ${args.id} (last change):\n${result.diff}`
    }
    case 'revert': {
      const target = storeScope()
      if (typeof target !== 'string') return target.error
      if (args.id === undefined) return 'memory:revert requires an id'
      if (args.revision === undefined) return 'memory:revert requires the revision to restore (revision)'
      const result = await memories.revert(target, workspace, args.id, args.revision)
      return renderNode(result.node, result.timeline)
    }
    default:
      return `unknown memory action "${args.action}"`
  }
}

/** Render one memory node plus timeline as compact text for the model. */
function renderNode(
  node: { id: string; title: string; content: string; scope: string; branch: string },
  timeline: { at: string; action: string; revision: string; message: string }[],
): string {
  const lines = [`## ${node.title}`, '', node.content, '', 'scope:', node.scope, 'branch:', node.branch]
  if (timeline.length > 0) {
    lines.push('', 'timeline:')
    for (const entry of timeline) lines.push(`- ${entry.at} ${entry.action} ${entry.revision} ${entry.message}`)
  }
  return lines.join('\n')
}

/** Render search hits with their first matching line as a compact list. */
function renderHits(hits: { id: string; title: string; snippet: string; matchCount: number }[]): string {
  return hits.map(hit => `${hit.id} (${hit.matchCount} 处匹配)\n  ${hit.snippet.slice(0, 120)}`).join('\n')
}

/** Derive a safe memory id from a title by kebab-casing and trimming. */
function slug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const slugged = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slugged === '' ? undefined : slugged
}

/**
 * Ids sharing `id`'s exact parent path (excluding `id` itself), sorted.
 * Root-level ids match other root-level ids; a nested id only matches ids in
 * its own directory, never descendants.
 */
export function similarIds(ids: readonly string[], id: string): string[] {
  const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
  return ids
    .filter((other) => {
      if (other === id) return false
      const otherParent = other.includes('/') ? other.slice(0, other.lastIndexOf('/')) : ''
      return otherParent === parent
    })
    .sort()
}
