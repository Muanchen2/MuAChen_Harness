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
 * silently. The same judgment also proposes a handoff memo when the turn
 * clearly leaves a task unfinished, so cross-session handoffs no longer rely
 * on agent self-discipline either.
 *
 * @module @deepseek-ai/dsh-memory-accumulate
 */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryService } from '@deepseek-ai/dsh-memory'
import { deriveEventMessage, type Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

export const name = 'memory-accumulate'
export const inject = ['llm', 'memories']

/** One candidate memory (or handoff memo) proposed by the judge. */
export interface MemoryCandidate {
  readonly title: string
  readonly content: string
}

/** One stale-memory archive proposal from the judge. */
export interface ArchiveCandidate {
  readonly id: string
  readonly reason: string
}

/** Durable producer facts for one accumulation prompt. */
export interface MemoryAccumulateSource {
  kind: 'rin-accumulate'
  /** The turn whose end produced these candidates. */
  readonly turn: number
  /** Candidate titles, for quick scanning. */
  readonly candidates: readonly string[]
  /** Handoff candidate titles, for quick scanning. */
  readonly handoffs: readonly string[]
  /** Archive proposal ids, for quick scanning. */
  readonly archives: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rin-accumulate': MemoryAccumulateSource
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * When to run the judge:
   * - `on-activity` (default): only turns with tool results.
   * - `always`: every turn end.
   * - `keyframe`: only at keyframes — a cheap rule pre-filter (wrap-up words,
   *   user-topic shift) or the `judgeInterval` fallback — so long sessions
   *   stop paying one LLM call per active turn; the judge itself confirms
   *   whether the fragment is a real keyframe and otherwise outputs nothing.
   */
  trigger?: 'on-activity' | 'always' | 'keyframe'
  /** Max candidate memories or handoff memos one turn may produce. */
  maxCandidates?: number
  /**
   * How many trailing messages of the judged turn the judge sees. The window
   * is the turn's own surface messages (a single long turn keeps its full
   * middle), capped at this many trailing messages.
   */
  maxInputMessages?: number
  /**
   * Max UTF-8 bytes of the framed judge input. Inputs over the cap are
   * trimmed from the head (the newest messages survive) instead of skipping
   * judgment.
   */
  maxInputBytes?: number
  /** Judge output-token cap. */
  maxOutputTokens?: number
  /** Judge request deadline in milliseconds. */
  timeoutMs?: number
  /** Keyframe fallback: judge at least every N turns (keyframe trigger only). */
  judgeInterval?: number
  /**
   * Rescue judgment before session compaction: when the harness compacts a
   * long conversation into a summary, the pre-compaction tail would otherwise
   * be invisible to the model forever. On `compaction/start` the plugin frames
   * the tail synchronously (before the replacement lands) and runs one judge
   * pass, so experience and handoff needs are distilled into memory first.
   */
  rescueOnCompact?: boolean
  /** Optional explicit provider route; must be paired with `model`. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  model?: string
}

export const Config: Schema<Config> = z.object({
  trigger: z.union([z.const('on-activity'), z.const('always'), z.const('keyframe')]).default('on-activity'),
  maxCandidates: z.number().step(1).min(1).default(2),
  maxInputMessages: z.number().step(1).min(1).default(30),
  maxInputBytes: z.number().step(1).min(1).default(32 * 1024),
  maxOutputTokens: z.number().step(1).min(1).default(512),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  judgeInterval: z.number().step(1).min(1).default(6),
  rescueOnCompact: z.boolean().default(true),
  provider: z.string(),
  model: z.string(),
})

/** The judge's stable system instruction. */
const JUDGE_SYSTEM = [
  '你是一个 AI 会话记忆筛选器，从会话片段中识别值得长期记住的项目经验。',
  '保留：修好的 bug、做出的架构决策、解决的坑、学到的环境或工具路径、带理由的立场改变。',
  '丢弃：纯过程叙述、状态汇报、琐碎内容。',
  '若片段只是任务进行中的普通进展（无任务切换、无收尾、无值得沉淀的经验），输出空候选。',
  '另识别交接需求：若片段明确表明任务尚未完成（用户要求"下次继续/先到这/还没搞定"，或助手总结出未完成的下一步与遗留坑），',
  '输出交接单候选：{"handoffs":[{"title":"简短任务名","content":"交接单内容，按 目标/进度/下一步/遗留坑/相关文件 五段组织"}]}。',
  '任务已完成或片段无交接信号时输出 {"handoffs":[]}。',
  '另识别被推翻的旧记忆：若片段明确推翻了下方"已有记忆"列表中的某条（结论相反/已被替代/明确作废），',
  '输出归档候选：{"archives":[{"id":"该记忆的 id","reason":"简短原因"}]}；无则 []。模糊判断不要提议。',
  '只输出一个 JSON 对象：{"candidates":[{"title":"简短标题","content":"事实性内容（发生了什么、结论）"}],"handoffs":[...],"archives":[...]}。',
  '没有候选时输出 {"candidates":[],"handoffs":[],"archives":[]}。JSON 之外不要输出任何文字。',
].join('\n')

/** The verifier's stable system instruction: compare candidates against real stored memories. */
const VERIFY_SYSTEM = [
  '你是记忆去重核实器。判断候选记忆与交接单是否与已有记忆重复：同主题即算重复，即使表述完全不同。',
  '已有记忆以"标题｜内容摘要"列出，逐条对照候选。',
  '只输出 JSON：{"candidates":[保留的候选原样条目],"handoffs":[保留的交接单原样条目]}（重复的移除）。',
  '没有保留时输出 {"candidates":[],"handoffs":[]}。JSON 之外不要输出任何文字。',
].join('\n')

/** Per-session candidates awaiting presentation; cleared once presented. */
const pendingCandidates = new WeakMap<Session, {
  turn: number
  candidates: MemoryCandidate[]
  handoffs: MemoryCandidate[]
  archives: ArchiveCandidate[]
}>()
/** Sessions with tool activity in the current turn, for the on-activity trigger. */
const activeTurns = new WeakSet<Session>()
/** Last judged turn per session, for the keyframe fallback interval. */
const lastJudged = new WeakMap<Session, number>()

/**
 * Keyframe pre-filter: a turn is worth one judge call when the latest real
 * user message carries an explicit keyframe signal — wrap-up wording (a
 * direct expression of the user's intent, not a heuristic guess) or an
 * explicit task-switch marker ("还有/另外/顺便/接下来…": the user openly
 * opens a new task, so the PREVIOUS task's experience deserves distilling
 * before it slips away). The fallback interval then guarantees a judge call
 * every `judgeInterval` turns regardless. Whether a turn is a real keyframe
 * (task switch, meaningful progress) is left to the judge itself, which is
 * instructed to output nothing for ordinary progress. Topic-shift guessing
 * was tried and removed: without Chinese word segmentation, shared character
 * fragments are coincidence, not topic — but explicit switch words are
 * intent, not guessing.
 */
const KEYFRAME_RE = /(先到(这|这儿|这里)?|就到这|先这样|差不多了|收尾|总结一下|总结下|结束(吧|了)?|下次(再|继续)|明天(再|继续)|交接|handoff|待办|还有|另外|顺便|接下来|换个|再帮|现在(做|来|弄)|新任务)/i

/** Real user messages on the durable event stream, oldest first, with their seq. */
function userTextsOf(session: Session): Array<{ at: number; text: string }> {
  const entries: Array<{ at: number; text: string }> = []
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    const data = event.data as {
      message?: { source?: { kind?: unknown }; content?: unknown }
      source?: { kind?: unknown }
      content?: unknown
    } | undefined
    // Real events nest the message under `data.message`; some plugin-injected
    // seeds flatten it — accept both shapes.
    const payload = data?.message ?? data
    if (payload === undefined || payload.source?.kind !== 'user') continue
    const content = (payload.content ?? []) as Array<{ text?: string } | string>
    const text = content.map(part => typeof part === 'string' ? part : (part.text ?? '')).join(' ')
    if (text.trim() !== '') entries.push({ at: event.seq, text })
  }
  return entries
}

/** Whether the turn deserves a judge call under the keyframe trigger. */
function isKeyframe(session: Session): boolean {
  const latest = userTextsOf(session).at(-1)
  return latest !== undefined && KEYFRAME_RE.test(latest.text)
}

/**
 * Archive every handoff memo on the session's ancestor chain whose title
 * marks it complete ("已完成"). Deterministic, reversible, zero LLM cost —
 * completed handoffs are explicit state, not a judgment call.
 * @returns how many memos were archived.
 */
async function autoArchiveCompletedHandoffs(
  memories: MemoryService,
  session: Session,
  logger: { warn(message: string, ...args: unknown[]): void },
): Promise<number> {
  const cwd = session.header.cwd
  if (cwd === undefined) return 0
  try {
    let archived = 0
    for (const entry of await memories.loadChain(cwd)) {
      for (const node of entry.nodes) {
        if (!node.id.startsWith('handoff/') || !node.title.includes('已完成')) continue
        const workspace = entry.scope === 'workspace' ? dirname(entry.store) : undefined
        await memories.archive(entry.scope, workspace, node.id)
        archived += 1
      }
    }
    return archived
  } catch (error) {
    // Maintenance must never break the session: log and continue.
    logger.warn('memory-accumulate: auto-archive failed: %o', error)
    return 0
  }
}

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

/**
 * Frame `messages`, trimming from the head until the framed input fits
 * `maxBytes`. The newest messages always survive — an oversized turn is
 * judged from its tail instead of being skipped silently.
 */
function frameWithinBytes(messages: readonly Message[], maxBytes: number): string {
  let keep = messages.length
  for (;;) {
    const framed = frameMessages(messages.slice(-keep))
    if (keep === 1 || Buffer.byteLength(framed, 'utf8') <= maxBytes) return framed
    keep -= 1
  }
}

/**
 * The surface messages belonging to `turn`: every message event appended at
 * or after the turn's own `turn/start` boundary, in model-visible order. A
 * long turn keeps its full middle instead of bleeding into an arbitrary
 * trailing window. Falls back to the full derived history when no matching
 * boundary exists (a first-turn judge or an unknown turn number).
 */
function turnSurfaceMessages(session: Session, turn: number): Message[] {
  let startSeq: number | undefined
  for (const event of session.events) {
    if (event.type !== 'turn/start') continue
    if ((event.data as { turn?: unknown } | undefined)?.turn === turn) startSeq = event.seq
  }
  if (startSeq === undefined) return session.deriveMessages()
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    if (seq < startSeq) continue
    // Surface sequences are valid log indexes by construction; the non-null
    // assertion expresses that invariant.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const message = deriveEventMessage(session.events[seq]!)
    if (message !== null) messages.push(message)
  }
  return messages
}

/** Parse one array of `{title, content}` entries from the judge's JSON answer. */
function parseList(text: string, key: 'candidates' | 'handoffs', max: number): MemoryCandidate[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    const list = (parsed as Record<string, unknown> | null)?.[key]
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

/**
 * Parse the judge's candidate-memory list tolerantly (code fences and stray prose allowed).
 * @param text - the judge's raw output text.
 * @param max - maximum number of candidates to keep.
 * @returns the parsed candidates, best first.
 */
export function parseCandidates(text: string, max: number): MemoryCandidate[] {
  return parseList(text, 'candidates', max)
}

/**
 * Parse the judge's handoff-memo list tolerantly (code fences and stray prose allowed).
 * @param text - the judge's raw output text.
 * @param max - maximum number of handoffs to keep.
 * @returns the parsed handoff memos.
 */
export function parseHandoffs(text: string, max: number): MemoryCandidate[] {
  return parseList(text, 'handoffs', max)
}

/**
 * Parse the judge's stale-memory archive proposals tolerantly.
 * @param text - the judge's raw output text.
 * @param max - maximum number of archive proposals to keep.
 * @returns the parsed archive candidates.
 */
export function parseArchives(text: string, max: number): ArchiveCandidate[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    const list = (parsed as Record<string, unknown> | null)?.['archives']
    if (!Array.isArray(list)) return []
    return list
      .filter((candidate): candidate is { id: string; reason: string } =>
        typeof candidate === 'object' && candidate !== null
        && typeof (candidate as { id?: unknown }).id === 'string'
        && (candidate as { id: string }).id.length > 0
        && typeof (candidate as { reason?: unknown }).reason === 'string')
      .slice(0, max)
      .map(candidate => ({ id: candidate.id, reason: candidate.reason }))
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

/** Titles, ids, and content heads of every memory on the session's ancestor chain (dedup + archive material). */
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
      return `${node.id} ${node.title}｜${body.slice(0, 120)}`
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
  const maxInputMessages = config.maxInputMessages ?? 30
  const maxInputBytes = config.maxInputBytes ?? 32 * 1024
  const maxOutputTokens = config.maxOutputTokens ?? 512
  const timeoutMs = config.timeoutMs ?? 30_000
  const judgeInterval = config.judgeInterval ?? 6
  const rescueOnCompact = config.rescueOnCompact ?? true

  /**
   * Run one judgment pass.
   * @param session - the session whose tail or turn is judged.
   * @param turn - the judged turn; with `tailOnly`, the turn number is
   *   informational (rescue runs before the compacted tail disappears).
   * @param tailOnly - use the trailing message window (rescue) instead of the
   *   turn's own surface messages (turn-end judgment).
   */
  const judge = async (session: Session, turn: number, tailOnly = false): Promise<void> => {
    try {
      // Layer 1 (deterministic, zero LLM): handoff memos whose title marks
      // them complete are archived automatically — an explicit state, and
      // archive is reversible, so this cannot lose anything.
      const autoArchived = await autoArchiveCompletedHandoffs(ctx.memories, session, ctx.logger)
      if (autoArchived > 0) ctx.logger.info('memory-accumulate: archived %d completed handoff memo(s)', autoArchived)
      const route = resolveRoute(session, config)
      if (route === undefined) {
        ctx.logger.warn('memory-accumulate: no provider/model route available; skipping judgment')
        return
      }
      const messages = tailOnly
        ? session.deriveMessages().slice(-maxInputMessages)
        : turnSurfaceMessages(session, turn).slice(-maxInputMessages)
      const framed = frameWithinBytes(messages, maxInputBytes)
      // Existing memory summaries go to the judge so it does not re-propose
      // stored topics (first pass), and then to the verifier which compares
      // the generated candidates against the real stored content (second
      // pass) — title lists alone were not enough to stop duplicates. The
      // same list carries ids so the judge can name stale memories to
      // archive (layer 2, proposal-only).
      const existing = await existingMemorySummaries(ctx.memories, session)
      const judgeSystem = existing.length === 0
        ? JUDGE_SYSTEM
        : `${JUDGE_SYSTEM}\n\n以下主题已存在于记忆库，不要重复提议：\n${existing.join('\n')}`
      const judgeText = await llmText(ctx, route, session, judgeSystem, framed, maxOutputTokens, timeoutMs)
      const list = parseCandidates(judgeText, maxCandidates)
      const handoffs = parseHandoffs(judgeText, maxCandidates)
      const archives = parseArchives(judgeText, maxCandidates)
      if (list.length === 0 && handoffs.length === 0 && archives.length === 0) return
      let verified = list
      let verifiedHandoffs = handoffs
      if (existing.length > 0) {
        try {
          const verifyInput = `候选记忆：\n${JSON.stringify({ candidates: list, handoffs })}\n\n已有记忆（标题｜内容摘要）：\n${existing.join('\n')}`
          const verifiedText = await llmText(ctx, route, session, VERIFY_SYSTEM, verifyInput, maxOutputTokens, timeoutMs)
          verified = parseCandidates(verifiedText, maxCandidates)
          verifiedHandoffs = parseHandoffs(verifiedText, maxCandidates)
        } catch (error) {
          ctx.logger.warn('memory-accumulate: verification failed, keeping unverified candidates: %o', error)
        }
      }
      if (verified.length > 0 || verifiedHandoffs.length > 0 || archives.length > 0) {
        pendingCandidates.set(session, { turn, candidates: verified, handoffs: verifiedHandoffs, archives })
      }
    } catch (error) {
      ctx.logger.warn('memory-accumulate: judgment failed: %o', error)
    }
  }

  ctx.on('session/event', (session, event) => {
    // `compaction/start` is declared by @deepseek-ai/dsh-compaction's type
    // merge; we avoid a cross-package type dependency and narrow it locally.
    const eventType = (event as { type?: string }).type
    if (eventType === 'compaction/start') {
      // Rescue pass: compaction is about to replace the conversation tail
      // with a summary. `judge` frames the tail synchronously (its first
      // await comes after frameMessages), so the pre-compaction messages are
      // captured here regardless of when the async LLM work settles.
      if (rescueOnCompact) {
        const turn = (event as { data?: { turn?: number | null } }).data?.turn
        // Rescue keeps the trailing window: there is no turn boundary for a
        // standalone compaction, and the tail is exactly what would vanish.
        void judge(session, turn ?? 0, true)
      }
      return
    }
    if (event.type !== 'turn/end') return
    const active = activeTurns.delete(session)
    const turn = event.data.turn
    if (trigger === 'always') {
      void judge(session, turn)
    } else if (trigger === 'keyframe') {
      const last = lastJudged.get(session)
      if (isKeyframe(session) || (last === undefined ? turn >= judgeInterval : turn - last >= judgeInterval)) {
        lastJudged.set(session, turn)
        void judge(session, turn)
      }
    } else if (active) {
      void judge(session, turn)
    }
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
    const sections: string[] = []
    if (pending.candidates.length > 0) {
      sections.push(
        `## 记忆沉淀候选（来自第 ${pending.turn} 轮）`,
        '',
        '系统检测到以下可能值得记住的项目经验，请决定是否写入 memory：',
        ...pending.candidates.flatMap((candidate, index) => [
          `${index + 1}. ${candidate.title}`,
          `   ${candidate.content.replace(/\n/g, '\n   ')}`,
        ]),
        '',
        '可用 memory remember 写入（按命名约定选择 id，同主题则更新已有记忆），修改后写入或忽略均可。',
      )
    }
    if (pending.handoffs.length > 0) {
      sections.push(
        `## 交接单候选（来自第 ${pending.turn} 轮）`,
        '',
        '系统检测到当前任务尚未完成，建议写入 handoff 交接单，下次会话会主动读取衔接：',
        ...pending.handoffs.flatMap((candidate, index) => [
          `${index + 1}. ${candidate.title}`,
          `   ${candidate.content.replace(/\n/g, '\n   ')}`,
        ]),
        '',
        '可用 memory remember 以 handoff/<任务名> 写入（结构：目标/进度/下一步/遗留坑/相关文件），或忽略。',
      )
    }
    if (pending.archives.length > 0) {
      sections.push(
        `## 归档候选（来自第 ${pending.turn} 轮）`,
        '',
        '系统检测到以下已有记忆可能已被推翻或过时，请确认是否归档（仅提议，不会自动执行）：',
        ...pending.archives.flatMap((candidate, index) => [
          `${index + 1}. ${candidate.id}：${candidate.reason}`,
        ]),
        '',
        '确认后用 memory archive <id> 归档（移入 archive/，可恢复），或忽略。',
      )
    }
    const text = sections.join('\n')
    const desired = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'rin-accumulate',
        turn: pending.turn,
        candidates: pending.candidates.map(candidate => candidate.title),
        handoffs: pending.handoffs.map(candidate => candidate.title),
        archives: pending.archives.map(candidate => candidate.id),
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
