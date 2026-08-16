import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as accumulate from '../src/index.ts'
import { parseCandidates, parseHandoffs, parseArchives } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-accumulate-${label}-`))
  roots.push(root)
  return root
}

/** Minimal scripted adapter: each model call consumes the next script entry. */
class FakeAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly script: (StreamChunk[] | 'fail')[]) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('adapter script exhausted')
    if (entry === 'fail') throw new Error('adapter exploded')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function liveContext(
  adapter: FakeAdapter,
  config: accumulate.Config = {},
): Promise<{ ctx: Context; adapter: FakeAdapter; centralRoot: string }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(LocalSubprocessRuntime)
  const centralRoot = join(tempRoot('central'), 'central')
  await ctx.plugin(MemoryService, { centralRoot })
  await ctx.plugin(accumulate, Object.assign({ provider: 'mock', model: 'm' }, config))
  return { ctx, adapter, centralRoot }
}

const testSignal = new AbortController().signal

function stubAgent(cwd?: string, events: unknown[] = []): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, events as never, cwd === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: 0 }
    : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('memory-accumulate must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function endTurn(ctx: Context, agent: Agent, turn: number): void {
  ctx.emit('session/event', agent.session, {
    type: 'turn/end', seq: 1, time: 1, data: { turn, reason: { kind: 'completed' as const } },
  })
}

/** A durable user-message event, as the real loop records it (keyframe detection reads session.events). */
function userEvent(text: string, index: number): unknown {
  return {
    type: 'user/message', seq: index, time: 1, surfaceOp: 'append',
    data: {
      id: `m${index}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

function toolResult(ctx: Context, agent: Agent): void {
  const exec: ToolExecution = {
    callId: CallId('tool-1'),
    rootCallId: CallId('tool-1'),
    token: Symbol('accumulate-test') as ToolExecutionToken,
    name: 'memory',
    arguments: { action: 'list' },
    agent,
    signal: testSignal,
  }
  ctx.emit('tools/result', exec, { isError: false, value: { text: 'ok' }, content: [] })
}

async function stepDecision(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[] = [],
): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 2, step: 1, signal: testSignal },
    async () => ({ kind: 'enter' as const, messages }),
  )
}

function accumulateMessages(decision: PreStepDecision): { text: string }[] {
  if (decision.kind !== 'enter') return []
  return decision.messages
    .filter((message): message is UserMessage & { source: { kind: 'rin-accumulate' } } =>
      message.source.kind === 'rin-accumulate')
    .map(message => ({ text: message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ') }))
}

const userPrompt = createUserMessage({
  content: [{ type: 'text', text: '继续' }],
  source: { kind: 'plugin', plugin: 'test' },
})

describe('the memory accumulation plugin', () => {
  it('judges an active turn and presents candidates at the next step', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [{ title: '修复了 ENOENT', content: 'store 目录缺失导致 spawn 失败' }] })),
    ]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('记忆沉淀候选')
    expect(injected?.text).toContain('修复了 ENOENT')
    expect(injected?.text).toContain('store 目录缺失导致 spawn 失败')
  })

  it('skips judgment for turns without tool activity under on-activity', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([textChunks('{"candidates":[]}')]))
    const agent = stubAgent()
    endTurn(ctx, agent, 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(adapter.requests).toEqual([])
  })

  it('judges every turn under always', async () => {
    const { ctx, adapter } = await liveContext(
      new FakeAdapter([textChunks('{"candidates":[]}')]),
      { trigger: 'always' },
    )
    const agent = stubAgent()
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
  })

  it('windows the judge input to the judged turn, not the trailing transcript', async () => {
    const { ctx, adapter } = await liveContext(
      new FakeAdapter([textChunks('{"candidates":[]}')]),
      { trigger: 'always' },
    )
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      userEvent('turn-one question', 1),
      { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 1, data: { turn: 2 } },
      userEvent('turn-two question', 4),
      { type: 'turn/end', seq: 5, time: 1, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const agent = stubAgent(undefined, events)
    endTurn(ctx, agent, 2)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    const input = JSON.stringify(adapter.requests[0]?.messages ?? [])
    expect(input).toContain('turn-two question')
    expect(input).not.toContain('turn-one question')
  })

  it('trims oversized judge input from the head instead of skipping judgment', async () => {
    const { ctx, adapter } = await liveContext(
      new FakeAdapter([textChunks('{"candidates":[]}')]),
      { trigger: 'always', maxInputBytes: 1024 },
    )
    const head = '头'.repeat(1000)
    const tail = '尾'.repeat(1000)
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      userEvent(head, 1),
      userEvent(tail, 2),
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const agent = stubAgent(undefined, events)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    const input = JSON.stringify(adapter.requests[0]?.messages ?? [])
    expect(input).toContain(tail)
    expect(input).not.toContain(head)
  })

  it('does not present when the judge finds no candidates', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([textChunks('{"candidates":[]}')]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    expect(accumulateMessages(decision)).toEqual([])
  })

  it('presents candidates only once', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [{ title: '一次性的', content: '只提示一次' }] })),
    ]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const first = await stepDecision(ctx, agent, [userPrompt])
    expect(accumulateMessages(first)).toHaveLength(1)
    const second = await stepDecision(ctx, agent, [userPrompt])
    expect(accumulateMessages(second)).toEqual([])
  })

  it('stays silent when the judge call fails', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter(['fail']))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    expect(accumulateMessages(decision)).toEqual([])
  })

  it('feeds existing memory summaries to the judge so topics are not re-proposed', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([textChunks('{"candidates":[]}')]))
    const workspace = join(tempRoot('dedup'), 'ws')
    await ctx.memories.remember('workspace', workspace, {
      id: 'design/rin-handoff', title: '会话交接机制设计', content: 'x',
    })
    const agent = stubAgent(workspace)
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
    expect(adapter.requests[0]?.system).toContain('会话交接机制设计')
    expect(adapter.requests[0]?.system).toContain('不要重复提议')
  })

  it('verifies candidates against stored memories before presenting', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      // first call: the judge still proposes a duplicate (and one fresh topic)
      textChunks(JSON.stringify({ candidates: [
        { title: '重复主题', content: '和已有记忆同主题' },
        { title: '全新主题', content: '真正的新结论' },
      ] })),
      // second call: the verifier drops the duplicate
      textChunks(JSON.stringify({ candidates: [{ title: '全新主题', content: '真正的新结论' }] })),
    ]))
    const workspace = join(tempRoot('verify'), 'ws')
    await ctx.memories.remember('workspace', workspace, {
      id: 'design/rin-handoff', title: '会话交接机制设计', content: '同主题内容',
    })
    const agent = stubAgent(workspace)
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(2) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('全新主题')
    expect(injected?.text).not.toContain('重复主题')
  })

  it('parseCandidates tolerates fences, stray prose, and garbage', () => {
    expect(parseCandidates('```json\n{"candidates":[{"title":"t","content":"c"}]}\n```', 2))
      .toEqual([{ title: 't', content: 'c' }])
    expect(parseCandidates('考虑了一下，结果是 {"candidates":[{"title":"a","content":"b"},{"title":"c","content":"d"}]} 就这样', 2))
      .toEqual([{ title: 'a', content: 'b' }, { title: 'c', content: 'd' }])
    expect(parseCandidates('no json here', 2)).toEqual([])
    expect(parseCandidates('{"candidates":"nope"}', 2)).toEqual([])
    expect(parseCandidates('{"candidates":[{"title":"","content":"x"}]}', 2)).toEqual([])
    expect(parseCandidates('{"candidates":[{"title":"t","content":"c"},{"title":"t2","content":"c2"},{"title":"t3","content":"c3"}]}', 2))
      .toHaveLength(2)
  })

  it('judges a handoff when the turn leaves the task unfinished', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [
        { title: '记忆分支语义收尾', content: '## 交接单：记忆分支语义收尾\n目标：交付分支语义\n进度：已完成\n下一步：推送' },
      ] })),
    ]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('交接单候选')
    expect(injected?.text).toContain('记忆分支语义收尾')
    expect(injected?.text).toContain('handoff/<任务名>')
  })

  it('presents handoffs even when the judge finds no memory candidates', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [{ title: '未完成的任务', content: '目标：x' }] })),
    ]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('交接单候选')
    expect(injected?.text).toContain('未完成的任务')
    expect(injected?.text).not.toContain('记忆沉淀候选')
  })

  it('verifies handoffs against stored handoff memos before presenting', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      // first call: the judge proposes a duplicate handoff (and one fresh one)
      textChunks(JSON.stringify({ candidates: [], handoffs: [
        { title: '重复交接单', content: '和已有交接单同主题' },
        { title: '新交接单', content: '真正的新任务' },
      ] })),
      // second call: the verifier drops the duplicate
      textChunks(JSON.stringify({ candidates: [], handoffs: [{ title: '新交接单', content: '真正的新任务' }] })),
    ]))
    const workspace = join(tempRoot('handoff-verify'), 'ws')
    await ctx.memories.remember('workspace', workspace, {
      id: 'handoff/rin-handoff', title: '重复交接单', content: '同主题内容',
    })
    const agent = stubAgent(workspace)
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(2) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('新交接单')
    expect(injected?.text).not.toContain('重复交接单')
  })

  it('parseHandoffs tolerates fences, stray prose, and garbage', () => {
    expect(parseHandoffs('```json\n{"handoffs":[{"title":"t","content":"c"}]}\n```', 2))
      .toEqual([{ title: 't', content: 'c' }])
    expect(parseHandoffs('no json here', 2)).toEqual([])
    expect(parseHandoffs('{"handoffs":"nope"}', 2)).toEqual([])
    expect(parseHandoffs('{"handoffs":[{"title":"","content":"x"}]}', 2)).toEqual([])
    expect(parseHandoffs('{"candidates":[{"title":"t","content":"c"}]}', 2)).toEqual([])
  })

  it('judges only at keyframes under the keyframe trigger', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [] })),
    ]), { trigger: 'keyframe' })
    // ordinary session: no wrap-up wording → no judge call
    const ordinary = stubAgent(undefined, [userEvent('继续之前的修复工作', 0), userEvent('继续做优化', 1)])
    toolResult(ctx, ordinary)
    endTurn(ctx, ordinary, 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(adapter.requests).toEqual([])

    // wrap-up wording → keyframe → judge runs
    const wrapping = stubAgent(undefined, [userEvent('继续之前的修复工作', 0), userEvent('先到这吧，下次继续', 1)])
    toolResult(ctx, wrapping)
    endTurn(ctx, wrapping, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
  })

  it('judges every judgeInterval turns as the keyframe fallback', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [] })),
      textChunks(JSON.stringify({ candidates: [], handoffs: [] })),
    ]), { trigger: 'keyframe', judgeInterval: 3 })
    const agent = stubAgent(undefined, Array.from({ length: 6 }, (_, index) => userEvent(`继续当前任务第 ${index + 1} 步`, index)))
    for (let turn = 1; turn <= 6; turn++) {
      endTurn(ctx, agent, turn)
    }
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(2) })
  })

  it('judges on an explicit task-switch wording under the keyframe trigger', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [] })),
    ]), { trigger: 'keyframe' })
    // "还有…" openly opens a new task: the previous task's experience
    // deserves a judge pass before it slips away
    const agent = stubAgent(undefined, [userEvent('还有这个 gpt 的，帮我一起配到 harness 吧', 0)])
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })
  })

  it('rescues experience before session compaction', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [{ title: '压缩前结论', content: '重要经验' }], handoffs: [] })),
    ]))
    const agent = stubAgent()
    // a compaction about to replace the conversation tail triggers a judge
    ctx.emit('session/event', agent.session, {
      type: 'compaction/start', seq: 1, time: 1, data: { turn: 7 },
    } as never)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    // the rescued candidate is presented at the next step boundary
    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('压缩前结论')
  })

  it('skips the rescue pass when rescueOnCompact is disabled', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [] })),
    ]), { rescueOnCompact: false })
    const agent = stubAgent()
    ctx.emit('session/event', agent.session, {
      type: 'compaction/start', seq: 1, time: 1, data: { turn: 7 },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(adapter.requests).toEqual([])
  })

  it('auto-archives completed handoff memos before judging', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [], archives: [] })),
    ]))
    const workspace = join(tempRoot('auto-archive'), 'ws')
    await ctx.memories.remember('workspace', workspace, { id: 'handoff/done-x', title: '交接单：任务 X — 已完成 ✅', content: '目标：…' })
    await ctx.memories.remember('workspace', workspace, { id: 'handoff/pending-y', title: '交接单：任务 Y', content: '目标：…' })

    const agent = stubAgent(workspace, [userEvent('先到这吧，下次继续', 0)])
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    // the completed memo was archived automatically; the open one stays
    expect(await ctx.memories.list('workspace', workspace)).toEqual(['handoff/pending-y'])
    expect((await ctx.memories.read('workspace', workspace, 'archive/handoff/done-x'))?.node.title).toContain('已完成')
  })

  it('presents archive proposals for the agent to confirm', async () => {
    const { ctx, adapter } = await liveContext(new FakeAdapter([
      textChunks(JSON.stringify({ candidates: [], handoffs: [], archives: [{ id: 'design/stale', reason: '被新结论推翻' }] })),
    ]))
    const agent = stubAgent()
    toolResult(ctx, agent)
    endTurn(ctx, agent, 1)
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    const decision = await stepDecision(ctx, agent, [userPrompt])
    const [injected] = accumulateMessages(decision)
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('归档候选')
    expect(injected?.text).toContain('design/stale')
    expect(injected?.text).toContain('memory archive')
  })

  it('parseArchives tolerates fences, stray prose, and garbage', () => {
    expect(parseArchives('```json\n{"archives":[{"id":"design/x","reason":"被推翻"}]}\n```', 2))
      .toEqual([{ id: 'design/x', reason: '被推翻' }])
    expect(parseArchives('no json here', 2)).toEqual([])
    expect(parseArchives('{"archives":"nope"}', 2)).toEqual([])
    expect(parseArchives('{"archives":[{"id":"","reason":"x"}]}', 2)).toEqual([])
    expect(parseArchives('{"archives":[{"id":"design/x"}]}', 2)).toEqual([])
  })
})
