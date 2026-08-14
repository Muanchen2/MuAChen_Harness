/**
 * Rin memory context injection.
 *
 * Read-side automation for the Rin memory system: at the first turn's model
 * request, every existing memory store along the workspace's ancestor chain
 * (and optionally the central store) is rendered into one user-role context
 * message and folded into the request. Any directory level may carry its own
 * `.dsh-memory` store; children inherit every ancestor's memories, so the
 * hierarchy is the directory tree itself, not a fixed set of scopes. The
 * injection refreshes when the agent writes memory through the `memory` tool,
 * so a remembered conclusion reaches the very next step. The `memory` tool
 * remains the write/maintenance surface; this plugin makes relevant
 * experience present without being asked.
 *
 * @module @deepseek-ai/dsh-memory-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { dirname, relative } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ChainContent } from '@deepseek-ai/dsh-memory'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

export const name = 'memory-context'
export const inject = ['memories']

/** The central store's label inside an injected source. */
const CENTRAL_LABEL = 'central'

/** Durable producer facts for one memory context injection. */
export interface MemoryContextSource {
  kind: 'rin-memory'
  /** Store directories that contributed, nearest first, plus `central` when included. */
  stores: readonly string[]
  /** Included node ids per store, in render order. */
  nodes: readonly { store: string; id: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rin-memory': MemoryContextSource
  }
}

/** Plugin configuration. */
export interface Config {
  /** Max rendered context bytes; sections beyond the budget are dropped from the tail (farthest levels first). */
  maxBytes?: number
}

export const Config: Schema<Config> = z.object({
  maxBytes: z.number().default(8192),
})

/** One rendered memory node. */
interface RenderNode {
  id: string
  title: string
  content: string
}

/** One store-level section of the rendered context. */
interface RenderSection {
  /** Section heading label (`workspace`, a `..`-relative path, or `central`). */
  label: string
  /** Canonical store identity for the source (store directory or `central`). */
  store: string
  nodes: readonly RenderNode[]
}

function isMemoryContext(message: UserMessage): boolean {
  return message.source.kind === 'rin-memory'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

/** Render one node as a markdown block. */
function renderNodeBlock(node: RenderNode): string {
  const title = node.title === node.id ? node.title : `${node.title}（${node.id}）`
  return `### ${title}\n${node.content}`
}

/** Render one store's nodes into a section, or an empty string when the store is empty. */
function renderStoreSection(section: RenderSection): string {
  if (section.nodes.length === 0) return ''
  return [`## Rin 记忆（${section.label}）`, '', ...section.nodes.map(renderNodeBlock)].join('\n')
}

/**
 * The heading label for one ancestor store: `workspace` for the session's own
 * directory, a `..`-relative path for higher levels.
 */
function chainLabel(cwd: string, store: string): string {
  const dir = dirname(store)
  return dir === cwd ? 'workspace' : relative(cwd, dir)
}

/**
 * Fold the store sections into one bounded text. Sections are kept from the
 * head, so an over-budget chain drops its farthest (tail) sections rather
 * than truncating mid-node.
 */
function renderBounded(sections: readonly RenderSection[], maxBytes: number): string {
  const rendered = sections
    .map(section => renderStoreSection(section))
    .filter(text => text !== '')
  const full = rendered.join('\n\n')
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full
  const kept: string[] = []
  let keptBytes = 0
  for (const section of rendered) {
    const sectionBytes = Buffer.byteLength(section, 'utf8')
    if (keptBytes + sectionBytes > maxBytes) break
    kept.push(section)
    keptBytes += sectionBytes
  }
  return `${kept.join('\n\n')}\n\n…（记忆超过上下文预算，已截断）`
}

/** Register the memory context injection. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxBytes ?? 8192

  const lifecycle = new AbortController()
  ctx.effect(() => () => {
    lifecycle.abort(new Error('memory-context disposed'))
  }, 'memory-context.lifecycle')

  const compose = async (agent: Agent, signal: AbortSignal): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const chain: ChainContent[] = await ctx.memories.loadChain(cwd)
    signal.throwIfAborted()
    const sections: RenderSection[] = chain.map(entry => ({
      label: entry.scope === 'central' ? CENTRAL_LABEL : chainLabel(cwd, entry.store),
      store: entry.store,
      nodes: entry.nodes.map(node => ({ id: node.id, title: node.title, content: node.content })),
    }))
    if (sections.every(section => section.nodes.length === 0)) return undefined
    const text = renderBounded(sections, maxBytes)
    if (text === '') return undefined
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'rin-memory',
        stores: sections.map(section => section.store),
        nodes: sections.flatMap(section => section.nodes.map(node => ({ store: section.store, id: node.id }))),
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isMemoryContext)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  // Emit listeners are not awaited, so a refresh composes against the inbox
  // produced by earlier refreshes for the same agent.
  const refreshTails = new WeakMap<Agent, Promise<void>>()

  const queueRefresh = (agent: Agent): void => {
    const previous = refreshTails.get(agent) ?? Promise.resolve()
    const current = previous.then(async () => {
      const desired = await compose(agent, lifecycle.signal)
      syncInbox(agent, [], desired)
    }).catch((error: unknown) => {
      if (!lifecycle.signal.aborted) ctx.logger.warn('memory context refresh failed: %o', error)
    })
    refreshTails.set(agent, current)
    void current.then(() => {
      if (refreshTails.get(agent) === current) refreshTails.delete(agent)
    })
  }

  const waitForRefreshes = async (agent: Agent): Promise<void> => {
    let refresh: Promise<void> | undefined
    while ((refresh = refreshTails.get(agent)) !== undefined) await refresh
  }

  ctx.on('agent/pre-step', async (
    { agent, messages, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    // Only the first turn carries the automatic memory context. Later turns
    // already hold it in the session history, and re-injecting the payload on
    // every request wastes the context budget; from turn 2 on the agent
    // queries memory through the `memory` tool instead.
    if (turn !== 1) {
      for (const message of agent.inbox.nextStep.filter(isMemoryContext)) {
        agent.inbox.remove(message.id)
      }
      return decision
    }
    await waitForRefreshes(agent)
    const pending = agent.inbox.nextStep.filter(isMemoryContext)
    const desired = await compose(agent, signal)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    if (exec.agent === undefined || exec.signal.aborted || result.isError) return
    const args = exec.arguments
    if (exec.name === 'memory'
      && typeof args === 'object' && args !== null
      && 'action' in args && args.action === 'remember') {
      queueRefresh(exec.agent)
    }
  })
}
