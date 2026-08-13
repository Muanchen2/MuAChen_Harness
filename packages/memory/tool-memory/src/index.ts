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

const MEMORY_GUIDANCE = 'Use memory tools to persist and recall cross-session project experience, '
  + 'distinct from skills (methods). Before a long task, recall the relevant workspace memory to '
  + 'restore prior conclusions and current state. After reaching a meaningful conclusion, a changed '
  + 'position, or a learned path, remember it so a future session can resume without repeating work. '
  + 'Keep memories factual and concise; store methods in skills, experience in memory.'

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
      scope: { type: 'string', required: true, enum: ['workspace', 'central'] },
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
  args: { action: string; scope: 'workspace' | 'central'; id?: string; title?: string; content?: string; message?: string },
): Promise<string> {
  const scope = args.scope
  const workspace = scope === 'workspace' ? cwd : undefined
  switch (args.action) {
    case 'remember': {
      const id = args.id ?? slug(args.title) ?? `memory-${Date.now()}`
      const title = args.title ?? id
      const content = args.content ?? ''
      const result = await memories.remember(scope, workspace, {
        id, title, content, ...args.message === undefined ? {} : { message: args.message },
      })
      return renderNode(result.node, result.timeline)
    }
    case 'read': {
      if (args.id === undefined) return 'memory:read requires an id'
      const found = await memories.read(scope, workspace, args.id)
      return found === undefined ? `no memory "${args.id}" in ${scope} store` : renderNode(found.node, found.timeline)
    }
    case 'list': {
      const ids = await memories.list(scope, workspace)
      return ids.length === 0 ? `no memories in ${scope} store` : ids.join('\n')
    }
    case 'timeline': {
      if (args.id === undefined) return 'memory:timeline requires an id'
      const timeline = await memories.timeline(scope, workspace, args.id)
      return timeline.length === 0
        ? `no timeline for memory "${args.id}"`
        : timeline.map(entry => `${entry.at} ${entry.message}`).join('\n')
    }
    default:
      return `unknown memory action "${args.action}"`
  }
}

/** Render one memory node plus timeline as compact text for the model. */
function renderNode(
  node: { id: string; title: string; content: string; scope: string; branch: string },
  timeline: { at: string; message: string }[],
): string {
  const lines = [`## ${node.title}`, '', node.content, '', 'scope:', node.scope, 'branch:', node.branch]
  if (timeline.length > 0) {
    lines.push('', 'timeline:')
    for (const entry of timeline) lines.push(`- ${entry.at} ${entry.message}`)
  }
  return lines.join('\n')
}

/** Derive a safe memory id from a title by kebab-casing and trimming. */
function slug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const slugged = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slugged === '' ? undefined : slugged
}
