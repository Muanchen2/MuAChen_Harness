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
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
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

/** Durable producer facts for one automatic-recall injection (turn 2+). */
export interface MemoryRecallSource {
  kind: 'rin-memory-recall'
  /** The turn that produced the recall. */
  readonly turn: number
  /** The retrieval queries that were run. */
  readonly queries: readonly string[]
  /** The recalled node ids, in rank order. */
  readonly nodes: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rin-memory': MemoryContextSource
    'rin-memory-recall': MemoryRecallSource
  }
}

/** Plugin configuration. */
export interface Config {
  /** Max rendered catalogue bytes; sections beyond the budget are dropped from the tail (farthest levels first). */
  maxBytes?: number
  /**
   * Automatic recall from turn 2 on: each request retrieves the top-N most
   * relevant stored memories (by keyword search over the recent execution
   * context — the latest tool results and assistant replies first, then the
   * user's latest message) and injects their summaries, so the agent reasons
   * with relevant experience at hand like a human recalling it — without
   * being asked. Ids already recalled in this session are not repeated. `0`
   * disables recall.
   */
  recallTopN?: number
}

export const Config: Schema<Config> = z.object({
  maxBytes: z.number().default(16 * 1024),
  recallTopN: z.number().step(1).min(0).default(3),
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

/**
 * Latin words with no retrieval value that lead error output: without
 * filtering, a failing tool result's first word (`syntaxerror`, `error`)
 * would consume the latin query budget before the meaningful keyword
 * (`enum`, `typescript`) appears.
 */
const QUERY_NOISE_WORDS = new Set(['error', 'syntaxerror', 'failed', 'failure', 'exception', 'undefined', 'aborted'])

/**
 * Retrieval queries for automatic recall: up to two latin words (≥3 chars,
 * noise words filtered) plus the longest CJK segment of the input (capped at
 * 20 chars). No word segmentation exists for CJK, so the longest segment is
 * the cheapest useful probe.
 */
function recallQueries(text: string): string[] {
  const queries: string[] = []
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  for (const word of words) {
    if (QUERY_NOISE_WORDS.has(word)) continue
    queries.push(word)
    if (queries.length >= 2) break
  }
  const segments = text.split(/[，。！？、；：\s]+/).filter(segment => segment.length > 0)
  if (segments.length > 0) {
    const longest = segments.reduce((a, b) => (b.length > a.length ? b : a))
    if (longest.length >= 2) queries.push(longest.slice(0, 20))
  }
  return [...new Set(queries)].slice(0, 3)
}

/** The text of the latest user-role message in the request. */
function lastUserText(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined) continue
    return message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' ')
  }
  return ''
}

/**
 * Recursively collect text from message content blocks. Tool results nest
 * their payload under a `tool-result` block whose own `content` is a block
 * array, so a naive top-level text scan would miss tool output entirely.
 */
function contentText(content: readonly { type: string; text?: unknown; content?: unknown }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      parts.push(contentText(block.content as { type: string; text?: unknown; content?: unknown }[]))
    }
  }
  return parts.join(' ')
}

/**
 * The text of the session's most recent surface messages — user prompts,
 * assistant replies, and tool results alike. Automatic recall should answer
 * what the agent is doing right now (a failing tool result, the step it is
 * about to take), not only the user's latest words, so the retrieval probes
 * ride the execution context. Tool results come FIRST (they are the
 * execution context itself; an assistant's narration would otherwise crowd
 * their error text out of the query budget), then the rest newest first.
 * Rin-injected messages are excluded: their own content would otherwise feed
 * the queries back to themselves.
 */
function recentSurfaceText(session: Session, maxMessages: number): string {
  const tail = session.deriveMessages().slice(-maxMessages).reverse()
  const kindOf = (message: Message): unknown => (message as { source?: { kind?: unknown } }).source?.kind
  const toolTexts: string[] = []
  const otherTexts: string[] = []
  for (const message of tail) {
    const kind = kindOf(message)
    if (typeof kind === 'string' && kind.startsWith('rin-')) continue
    const text = contentText(message.content)
    if (text.trim() === '') continue
    ;(kind === 'tool' ? toolTexts : otherTexts).push(text)
  }
  return [...toolTexts, ...otherTexts].join(' ')
}

function sameRecallPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

/**
 * Whether the session surface already carries a user message with this exact
 * payload. `agent/pre-step` only offers the newly claimed batch, so a payload
 * injected by an earlier step of the same turn (or an earlier turn) lives in
 * the surface, not in `decision.messages` — without this check a long turn 1
 * (a single prompt that drives dozens of steps) would re-inject the catalogue
 * on every step.
 */
function alreadyOnSurface(agent: Agent, payload: UserMessage): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message' && sameContextPayload(event.data, payload)
  })
}

/** Register the memory context injection. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBytes = config.maxBytes ?? 16 * 1024
  const recallTopN = config.recallTopN ?? 3

  const lifecycle = new AbortController()
  ctx.effect(() => () => {
    lifecycle.abort(new Error('memory-context disposed'))
  }, 'memory-context.lifecycle')

  // Memory ids already recalled in this session: automatic recall never
  // repeats what the agent already saw.
  const recalledIds = new WeakMap<Session, Set<string>>()

  /**
   * Retrieve the top-N relevant memories for the latest user message and
   * render their summaries as one context message. Handoff memos are
   * excluded (they have their own pickup channel), archived nodes are
   * already excluded by search.
   */
  const composeRecall = async (
    agent: Agent,
    messages: readonly UserMessage[],
    turn: number,
    signal: AbortSignal,
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    // Execution context first (recent tool results and assistant replies, so
    // a failing command's error text drives retrieval), the user's latest
    // words second (the direct prompt remains the primary intent probe).
    const queries = recallQueries(`${recentSurfaceText(agent.session, 3)} ${lastUserText(messages)}`)
    if (queries.length === 0) return undefined
    signal.throwIfAborted()
    const seen = recalledIds.get(agent.session) ?? new Set<string>()
    const byId = new Map<string, { title: string; snippet: string; count: number }>()
    for (const query of queries) {
      try {
        for (const entry of await ctx.memories.searchChain(cwd, query)) {
          for (const hit of entry.hits) {
            if (seen.has(hit.id) || hit.id.startsWith('handoff/')) continue
            const current = byId.get(hit.id)
            if (current === undefined || hit.matchCount > current.count) {
              byId.set(hit.id, { title: hit.title, snippet: hit.snippet, count: hit.matchCount })
            }
          }
        }
      } catch {
        // one failing query must not kill recall
      }
      signal.throwIfAborted()
    }
    const ranked = [...byId.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, recallTopN)
    if (ranked.length === 0) return undefined
    for (const [id] of ranked) seen.add(id)
    recalledIds.set(agent.session, seen)
    const lines = [
      `## 相关记忆（自动联想，第 ${turn} 轮）`,
      '',
      '与当前任务相关的既有经验摘要（按相关性排序）：',
      ...ranked.map(([id, hit]) => `- ${id}：${hit.snippet.slice(0, 120)}`),
      '',
      '需要详情用 memory read 展开；与任务无关可忽略。',
    ]
    return createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: {
        kind: 'rin-memory-recall',
        turn,
        queries,
        nodes: ranked.map(([id]) => id),
      },
    })
  }

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
    // Only the first turn carries the automatic memory catalogue. Later turns
    // already hold it in the session history, and re-injecting the payload on
    // every request wastes the context budget; from turn 2 on the agent gets
    // automatic recall instead: the top-N relevant memory summaries for the
    // latest user message, so reasoning happens with experience at hand.
    if (turn !== 1) {
      for (const message of agent.inbox.nextStep.filter(isMemoryContext)) {
        agent.inbox.remove(message.id)
      }
      if (recallTopN > 0 && decision.kind === 'enter' && decision.messages.length > 0) {
        const recall = await composeRecall(agent, messages, turn, signal)
        signal.throwIfAborted()
        if (recall !== undefined
          && !decision.messages.some(message => sameRecallPayload(message, recall))
          && !alreadyOnSurface(agent, recall)) {
          const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
          const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, recall)
          return { kind: 'enter', messages: entered }
        }
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
    // `desired`, or its payload is already covered by the batch or the surface
    // (an earlier step of this long turn injected it already).
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined
      || decision.messages.some(message => sameContextPayload(message, desired))
      || alreadyOnSurface(agent, desired)) {
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
