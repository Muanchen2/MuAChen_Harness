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
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
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
  /** Max rendered catalogue bytes; sections beyond the budget are dropped from the tail (farthest levels first). */
  maxBytes?: number
}

export const Config: Schema<Config> = z.object({
  maxBytes: z.number().default(16 * 1024),
})

/** One catalogue entry (title + id); contents are fetched on demand via the memory tool. */
interface RenderNode {
  id: string
  title: string
}

/** One store-level section of the rendered catalogue. */
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

/** Render one store's memory catalogue (titles and ids only), or an empty string when empty. */
function renderStoreSection(section: RenderSection): string {
  if (section.nodes.length === 0) return ''
  const lines = [`## Rin 记忆目录（${section.label}）`, '']
  for (const node of section.nodes) {
    lines.push(`- [${node.id}] ${node.title}`)
  }
  return lines.join('\n')
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
 * than truncating mid-entry.
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
  return `${kept.join('\n\n')}\n\n…（记忆目录超过上下文预算，已截断；可用 memory list/read 查询其余）`
}

/** The fetch hint appended after the catalogue. */
const CATALOGUE_HINT = '需要详细内容时，用 memory read（scope 可选 workspace/chain/central）按 id 查询。'

/** Register the memory context injection. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxBytes ?? 16 * 1024

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
      // Archived nodes stay out of the injected catalogue: they are shelf
      // material, readable on demand via memory read archive/<id>.
      nodes: entry.nodes
        .filter(node => !node.id.startsWith('archive/'))
        .map(node => ({ id: node.id, title: node.title })),
    }))
    if (sections.every(section => section.nodes.length === 0)) return undefined
    const catalogue = renderBounded(sections, maxBytes)
    if (catalogue === '') return undefined
    // Unfinished handoff memos deserve explicit attention: the session should
    // pick the task up instead of waiting to be told. A handoff whose title
    // marks it complete ("已完成") is no longer a pickup candidate.
    const handoffs = sections.flatMap(section =>
      section.nodes.filter(node => node.id.startsWith('handoff/') && !node.title.includes('已完成')))
    const handoffNote = handoffs.length === 0
      ? ''
      : `\n\n⏳ 有 ${handoffs.length} 条未完成任务交接单（handoff/）：${handoffs.map(node => node.id).join('、')}。请用 memory read 读取并衔接继续。`
    const text = `${catalogue}\n\n${CATALOGUE_HINT}${handoffNote}`
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

  // Session → agent/turn facts: the injection must only run inside turn 1.
  // Inbox messages are claimed by the agent loop BEFORE `agent/pre-step`
  // fires, so a refresh landing in the inbox during turn 2+ would still ride
  // the request despite the turn gate — refresh must be gated at the source.
  const agentRefs = new WeakMap<Session, Agent>()
  const turnState = new WeakMap<Session, number>()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    // A finished turn must not leave pending context behind: the next turn's
    // inbox claim would otherwise carry it into the request.
    const agent = agentRefs.get(session)
    if (agent === undefined) return
    for (const message of agent.inbox.nextStep.filter(isMemoryContext)) {
      agent.inbox.remove(message.id)
    }
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    agentRefs.set(agent.session, agent)
    turnState.set(agent.session, turn)
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
      && 'action' in args && args.action === 'remember'
      && turnState.get(exec.agent.session) === 1) {
      queueRefresh(exec.agent)
    }
  })
}
