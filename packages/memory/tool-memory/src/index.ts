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
  + '或者改变了立场。任务未完成需要交接时，写 handoff/<任务名> 交接单（结构：目标/进度/下一步/'
  + '遗留坑/相关文件）。记忆保持事实性与简洁；可复用的方法存入 skills，经验存入 memory。'

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
      action: { type: 'string', required: true, enum: ['remember', 'read', 'list', 'timeline'] },
      scope: { type: 'string', required: true, enum: ['workspace', 'central', 'chain'] },
      id: { type: 'string', description: 'Memory node id for read/timeline, or the id to save under for remember.' },
      title: { type: 'string', description: 'Title for remember; the new memory heading.' },
      content: { type: 'string', description: 'Body for remember; the experience to persist.' },
      message: { type: 'string', description: 'Optional one-line commit note for this change.' },
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
  args: { action: string; scope: 'workspace' | 'central' | 'chain'; id?: string; title?: string; content?: string; message?: string },
): Promise<string> {
  const scope = args.scope
  const workspace = scope === 'workspace' ? cwd : undefined
  switch (args.action) {
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
      const ids = await memories.list(scope, workspace)
      return ids.length === 0 ? `no memories in ${scope} store` : ids.join('\n')
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
