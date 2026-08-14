/**
 * Rin memory accumulation (half-automatic distillation).
 *
 * At each turn end an auxiliary LLM call judges whether the turn produced
 * experience worth keeping (a bug fixed, a decision made, a pitfall solved, a
 * learned path). Candidate memories are cached per session and presented to
 * the agent at the next step boundary; the agent decides to write them
 * through the `memory` tool (editing or dropping as it sees fit). Judgment is
 * the system's — reliable without trusting agent self-discipline — while the
 * write stays a conscious agent action, so noise never enters the stores
 * silently.
 *
 * @module @deepseek-ai/dsh-memory-accumulate
 */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryService } from '@deepseek-ai/dsh-memory'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

export const name = 'memory-accumulate'
export const inject = ['llm', 'memories']

/** One candidate memory proposed by the judge. */
export interface MemoryCandidate {
  readonly title: string
  readonly content: string
}

/** Durable producer facts for one accumulation prompt. */
export interface MemoryAccumulateSource {
  kind: 'rin-accumulate'
  /** The turn whose end produced these candidates. */
  readonly turn: number
  /** Candidate titles, for quick scanning. */
  readonly candidates: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rin-accumulate': MemoryAccumulateSource
  }
}

/** Plugin configuration. */
export interface Config {
  /** When to run the judge: every turn end, or only turns with tool activity. */
  trigger?: 'on-activity' | 'always'
  /** Max candidate memories one turn may produce. */
  maxCandidates?: number
  /** How many trailing messages the judge sees. */
  maxInputMessages?: number
  /** Max UTF-8 bytes of the framed judge input. */
  maxInputBytes?: number
  /** Judge output-token cap. */
  maxOutputTokens?: number
  /** Judge request deadline in milliseconds. */
  timeoutMs?: number
  /** Optional explicit provider route; must be paired with `model`. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  model?: string
}

export const Config: Schema<Config> = z.object({
  trigger: z.union([z.const('on-activity'), z.const('always')]).default('on-activity'),
  maxCandidates: z.number().step(1).min(1).default(2),
  maxInputMessages: z.number().step(1).min(1).default(12),
  maxInputBytes: z.number().step(1).min(1).default(16 * 1024),
  maxOutputTokens: z.number().step(1).min(1).default(512),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  provider: z.string(),
  model: z.string(),
})

/** The judge's stable system instruction. */
const JUDGE_SYSTEM = [
  '你是一个 AI 会话记忆筛选器，从会话片段中识别值得长期记住的项目经验。',
  '保留：修好的 bug、做出的架构决策、解决的坑、学到的环境或工具路径、带理由的立场改变。',
  '丢弃：纯过程叙述、状态汇报、琐碎内容。',
  '只输出一个 JSON 对象：{"candidates":[{"title":"简短标题","content":"事实性内容（发生了什么、结论）"}]}。',
  '没有候选时输出 {"candidates":[]}。JSON 之外不要输出任何文字。',
].join('\n')

/** The verifier's stable system instruction: compare candidates against real stored memories. */
const VERIFY_SYSTEM = [
  '你是记忆去重核实器。判断候选记忆是否与已有记忆重复：同主题即算重复，即使表述完全不同。',
  '已有记忆以"标题｜内容摘要"列出，逐条对照候选。',
  '只输出 JSON：{"candidates":[保留的候选原样条目]}（重复的移除）。',
  '没有保留时输出 {"candidates":[]}。JSON 之外不要输出任何文字。',
].join('\n')

/** Per-session candidates awaiting presentation; cleared once presented. */
const pendingCandidates = new WeakMap<Session, { turn: number; list: MemoryCandidate[] }>()
/** Sessions with tool activity in the current turn, for the on-activity trigger. */
const activeTurns = new WeakSet<Session>()

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return new Error(finish.failure.message)
    case 'max-tokens':
      return new Error('memory-accumulate: judge output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('memory-accumulate: judge unexpectedly requested a tool')
    default:
      return new Error(`memory-accumulate: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Frame the trailing messages as JSON so transcript text cannot break structure. */
function frameMessages(messages: readonly Message[]): string {
  const view = messages.map(message => ({
    role: message.role,
    text: message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' '),
  }))
  return `待筛选的会话片段（JSON 数组）：\n${JSON.stringify(view)}`
}

/** Parse the judge's JSON answer tolerantly (code fences and stray prose allowed). */
export function parseCandidates(text: string, max: number): MemoryCandidate[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    const list = (parsed as { candidates?: unknown } | null)?.candidates
    if (!Array.isArray(list)) return []
    return list
      .filter((candidate): candidate is { title: string; content: string } =>
        typeof candidate === 'object' && candidate !== null
        && typeof (candidate as { title?: unknown }).title === 'string'
        && typeof (candidate as { content?: unknown }).content === 'string'
        && (candidate as { title: string }).title.length > 0)
      .slice(0, max)
      .map(candidate => ({ title: candidate.title, content: candidate.content }))
  } catch {
    return []
  }
}

/** The session's route: explicit config pair, else the latest request header. */
function resolveRoute(
  session: Session,
  config: Config,
): { provider: string; model: string } | undefined {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  for (const event of session.events) {
    if (event.type !== 'request/header') continue
    return { provider: event.data.header.config.provider, model: event.data.header.config.model }
  }
  return undefined
}

/** Titles and content heads of every memory on the session's ancestor chain (dedup material). */
async function existingMemorySummaries(
  memories: MemoryService,
  session: Session,
): Promise<string[]> {
  const cwd = session.header.cwd
  if (cwd === undefined) return []
  try {
    const chain = await memories.loadChain(cwd)
    return chain.flatMap(entry => entry.nodes.map((node) => {
      const body = node.content.replace(/\s+/g, ' ').trim()
      return `${node.title}｜${body.slice(0, 120)}`
    }))
  } catch {
    return []
  }
}

/** One auxiliary LLM text call (judge or verifier). */
async function llmText(
  ctx: Context,
  route: { provider: string; model: string },
  session: Session,
  system: string,
  input: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'plugin', plugin: 'dsh-memory-accumulate' },
  })]
  using callDeadline = deadline(new AbortController().signal, timeoutMs, 'MEMORY_ACCUMULATE_TIMEOUT')
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens,
    sessionId: session.id,
    signal: callDeadline.signal,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  return assembler.blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

function samePayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}
export function apply(ctx: Context, config: Config = {}): void {
  const trigger = config.trigger ?? 'on-activity'
  const maxCandidates = config.maxCandidates ?? 2
  const maxInputMessages = config.maxInputMessages ?? 12
  const maxInputBytes = config.maxInputBytes ?? 16 * 1024
  const maxOutputTokens = config.maxOutputTokens ?? 512
  const timeoutMs = config.timeoutMs ?? 30_000

  const judge = async (session: Session, turn: number): Promise<void> => {
    try {
      const route = resolveRoute(session, config)
      if (route === undefined) {
        ctx.logger.warn('memory-accumulate: no provider/model route available; skipping judgment')
        return
      }
      const framed = frameMessages(session.deriveMessages().slice(-maxInputMessages))
      if (Buffer.byteLength(framed, 'utf8') > maxInputBytes) return
      // Existing memory summaries go to the judge so it does not re-propose
      // stored topics (first pass), and then to the verifier which compares
      // the generated candidates against the real stored content (second
      // pass) — title lists alone were not enough to stop duplicates.
      const existing = await existingMemorySummaries(ctx.memories, session)
      const judgeSystem = existing.length === 0
        ? JUDGE_SYSTEM
        : `${JUDGE_SYSTEM}\n\n以下主题已存在于记忆库，不要重复提议：\n${existing.join('\n')}`
      const list = parseCandidates(
        await llmText(ctx, route, session, judgeSystem, framed, maxOutputTokens, timeoutMs),
        maxCandidates,
      )
      if (list.length === 0) return
      let verified = list
      if (existing.length > 0) {
        try {
          const verifyInput = `候选记忆：\n${JSON.stringify(list)}\n\n已有记忆（标题｜内容摘要）：\n${existing.join('\n')}`
          verified = parseCandidates(
            await llmText(ctx, route, session, VERIFY_SYSTEM, verifyInput, maxOutputTokens, timeoutMs),
            maxCandidates,
          )
        } catch (error) {
          ctx.logger.warn('memory-accumulate: verification failed, keeping unverified candidates: %o', error)
        }
      }
      if (verified.length > 0) pendingCandidates.set(session, { turn, list: verified })
    } catch (error) {
      ctx.logger.warn('memory-accumulate: judgment failed: %o', error)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const active = activeTurns.delete(session)
    if (trigger === 'always' || active) void judge(session, event.data.turn)
  })

  ctx.on('tools/result', (exec: ToolExecution) => {
    if (exec.agent === undefined || exec.signal.aborted) return
    activeTurns.add(exec.agent.session)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    const pending = pendingCandidates.get(agent.session)
    if (pending === undefined) return decision
    if (decision.kind === 'reject' || decision.messages.length === 0) return decision
    const text = [
      `## 记忆沉淀候选（来自第 ${pending.turn} 轮）`,
      '',
      '系统检测到以下可能值得记住的项目经验，请决定是否写入 memory：',
      ...pending.list.flatMap((candidate, index) => [
        `${index + 1}. ${candidate.title}`,
        `   ${candidate.content.replace(/\n/g, '\n   ')}`,
      ]),
      '',
      '可用 memory remember 写入（按命名约定选择 id，同主题则更新已有记忆），修改后写入或忽略均可。',
    ].join('\n')
    const desired = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'rin-accumulate',
        turn: pending.turn,
        candidates: pending.list.map(candidate => candidate.title),
      },
    })
    pendingCandidates.delete(agent.session)
    signal.throwIfAborted()
    if (decision.messages.some(message => samePayload(message, desired))) return decision
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })
}
