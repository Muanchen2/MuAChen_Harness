import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import MemoryService from '../../dsh-memory/src/index.ts'
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import * as memoryContext from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-memory-context-${label}-`))
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
  centralRoot: string,
  config: memoryContext.Config = {},
  adapter?: FakeAdapter,
): Promise<{ ctx: Context; memories: MemoryService; adapter: FakeAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const llmAdapter = adapter ?? new FakeAdapter([])
  ctx.llm.registerAdapter(['mock'], llmAdapter)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(MemoryService, { centralRoot })
  await ctx.plugin(memoryContext, Object.assign({ provider: 'mock', model: 'm' }, config))
  return { ctx, memories: ctx.memories, adapter: llmAdapter }
}

const testSignal = new AbortController().signal

function stubAgent(cwd: string, seed: SessionEvent[] = []): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, seed, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
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
    inject: () => { throw new Error('memory-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Run one `agent/pre-step` waterfall with the fallback deciding `enter`. */
async function stepDecision(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[] = [],
  step = 1,
  turn = 1,
): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn, step, signal: testSignal },
    async () => ({ kind: 'enter' as const, messages }),
  )
}

/** A blank first step parks the context in the inbox; claim it, then fold on the next step. */
async function foldedDecision(ctx: Context, agent: Agent): Promise<PreStepDecision> {
  await stepDecision(ctx, agent, [], 1)
  const claimed = agent.inbox.claim('next-step', 1)
  return stepDecision(ctx, agent, claimed, 2)
}

function blocksText(blocks: { type: string; text?: string }[] | undefined): string {
  return blocks?.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n') ?? ''
}

function isRinMemory(message: UserMessage): boolean {
  return message.source.kind === 'rin-memory'
}

/** Extract injected rin-memory messages, keeping the full message for re-feeding. */
function memoryMessages(decision: PreStepDecision): { text: string; message: UserMessage }[] {
  if (decision.kind !== 'enter') return []
  return decision.messages.filter(isRinMemory).map(message => ({ text: blocksText(message.content), message }))
}

function rememberExecution(agent: Agent): ToolExecution {
  return {
    callId: CallId('memory-call'),
    rootCallId: CallId('memory-call'),
    token: Symbol('memory-context-test-execution') as ToolExecutionToken,
    name: 'memory',
    arguments: { action: 'remember', scope: 'workspace', title: 'Fresh', content: 'fresh conclusion' },
    agent,
    signal: testSignal,
  }
}

const successResult: ToolExecutionResult = { isError: false, value: { text: 'ok' }, content: [] }

describe('the memory context injection', () => {
  it('folds the workspace memory catalogue into the first step', async () => {
    const root = tempRoot('workspace')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, {
      id: 'alpha', title: 'Alpha', content: 'first experience',
    })

    const agent = stubAgent(workspace)
    const decision = await foldedDecision(ctx, agent)

    expect(decision.kind).toBe('enter')
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('## Rin 记忆目录（workspace）')
    expect(injected?.text).toContain('- [alpha] Alpha')
    // contents are fetched on demand, not injected
    expect(injected?.text).not.toContain('first experience')
    expect(injected?.text).toContain('memory read')
  })

  it('injects the catalogue once across multiple turn-1 steps', async () => {
    const root = tempRoot('multi-step')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, {
      id: 'alpha', title: 'Alpha', content: 'first experience',
    })
    const agent = stubAgent(workspace)
    const prompt = createUserMessage({
      content: [{ type: 'text', text: '开始干活' }],
      source: { kind: 'plugin', plugin: 'test' },
    })

    // Step 1 of turn 1 injects the catalogue...
    const first = await stepDecision(ctx, agent, [prompt], 1, 1)
    const firstMemory = first.kind === 'enter' ? first.messages.filter(isRinMemory) : []
    expect(firstMemory).toHaveLength(1)
    // ...and the loop persists it to the surface (the real agent-loop appends
    // the entered batch before the next step's pre-step).
    for (const message of firstMemory) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }

    // Step 2 of the same long turn must NOT re-inject the same payload.
    const second = await stepDecision(ctx, agent, [prompt], 2, 1)
    const secondMemory = second.kind === 'enter' ? second.messages.filter(isRinMemory) : []
    expect(secondMemory).toHaveLength(0)
  })

  it('includes the central store as the final chain level', async () => {
    const root = tempRoot('central-included')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'local', title: 'Local', content: 'local note' })
    await memories.remember('central', undefined, { id: 'shared', title: 'Shared', content: 'cross-project note' })

    const agent = stubAgent(workspace)
    const decision = await foldedDecision(ctx, agent)
    const injected = memoryMessages(decision)[0]
    expect(injected?.text).toContain('- [local] Local')
    expect(injected?.text).toContain('- [shared] Shared')
    expect(injected?.text).toContain('## Rin 记忆目录（central）')
  })

  it('injects nothing when both stores are empty', async () => {
    const root = tempRoot('empty')
    const workspace = join(root, 'ws')
    const { ctx } = await liveContext(join(root, 'central'))

    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent)

    expect(decision.kind).toBe('enter')
    expect(memoryMessages(decision)).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
  })

  it('bounds the rendered catalogue and marks the trim', async () => {
    const root = tempRoot('bounded')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'), { maxBytes: 150 })
    // the nearest store fits the budget; the central catalogue does not
    await memories.remember('workspace', workspace, { id: 'a1', title: 'A1', content: 'x' })
    await memories.remember('workspace', workspace, { id: 'a2', title: 'A2', content: 'x' })
    for (let index = 1; index <= 12; index += 1) {
      await memories.remember('central', undefined, {
        id: `c${String(index).padStart(2, '0')}`, title: `C${index}`, content: 'x',
      })
    }

    const decision = await foldedDecision(ctx, stubAgent(workspace))
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('已截断')
    expect(injected?.text).toContain('- [a1] A1')
    expect(injected?.text).not.toContain('- [c01] C1')
  }, 20_000)

  it('refreshes the pending context after a memory remember tool result', async () => {
    const root = tempRoot('refresh')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))

    const agent = stubAgent(workspace)
    const before = await stepDecision(ctx, agent)
    expect(memoryMessages(before)).toEqual([])

    // The tool writes, then its result triggers the refresh.
    await memories.remember('workspace', workspace, {
      id: 'fresh', title: 'Fresh', content: 'fresh conclusion',
    })
    ctx.emit('tools/result', rememberExecution(agent), successResult)
    const pending = await vi.waitFor(() => {
      const message = agent.inbox.nextStep.find(isRinMemory)
      expect(message).toBeDefined()
      return message
    })
    expect(blocksText(pending?.content)).toContain('- [fresh] Fresh')

    // The next proceeding step folds the pending context and clears it.
    const after = await foldedDecision(ctx, agent)
    expect(memoryMessages(after).some(item => item.text.includes('- [fresh] Fresh'))).toBe(true)
  })

  it('does not re-enter a context whose payload already rides the request', async () => {
    const root = tempRoot('dedupe')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'first experience' })

    const agent = stubAgent(workspace)
    const first = await foldedDecision(ctx, agent)
    const injected = memoryMessages(first)[0]
    expect(injected).toBeDefined()

    const second = await stepDecision(ctx, agent, injected?.message === undefined ? [] : [injected.message], 2)
    // The claimed context rides the request untouched: no fresh message entered.
    const secondMemories = memoryMessages(second)
    expect(secondMemories).toHaveLength(1)
    expect(secondMemories[0]?.message).toBe(injected?.message)
  })

  it('injects only in the first turn and clears pending context afterwards', async () => {
    const root = tempRoot('later-turns')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'first experience' })

    const agent = stubAgent(workspace)
    // Turn 1 injects once...
    const first = await foldedDecision(ctx, agent)
    expect(memoryMessages(first)).toHaveLength(1)

    // ...but turn 2 carries no fresh injection and clears any pending context.
    const second = await stepDecision(ctx, agent, [], 1, 2)
    expect(memoryMessages(second)).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
  })

  it('does not refresh the catalogue after a remember outside turn 1', async () => {
    const root = tempRoot('late-refresh')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'alpha', title: 'Alpha', content: 'first experience' })

    const agent = stubAgent(workspace)
    // turn 1 runs; turn 2 is now the current turn
    await foldedDecision(ctx, agent)
    await stepDecision(ctx, agent, [], 1, 2)

    // a remember inside turn 2 must NOT refresh the pending context
    await memories.remember('workspace', workspace, { id: 'beta', title: 'Beta', content: 'second' })
    ctx.emit('tools/result', rememberExecution(agent), successResult)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(agent.inbox.nextStep).toEqual([])

    // and the next turn-2 step carries no injection either
    const decision = await stepDecision(ctx, agent, [], 1, 2)
    expect(memoryMessages(decision)).toEqual([])
  })

  it('injects ancestor-chain stores from nearest to farthest', async () => {
    const root = tempRoot('chain-inject')
    const a = join(root, 'a')
    const b = join(a, 'b')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', a, { id: 'parent', title: 'Parent', content: 'parent level' })
    await memories.remember('workspace', b, { id: 'leaf', title: 'Leaf', content: 'leaf level' })

    const decision = await foldedDecision(ctx, stubAgent(b))
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('## Rin 记忆目录（workspace）')
    expect(injected?.text).toContain('- [leaf] Leaf')
    expect(injected?.text).toContain('## Rin 记忆目录（..）')
    expect(injected?.text).toContain('- [parent] Parent')
  })

  it('flags unfinished handoff memos for immediate pickup', async () => {
    const root = tempRoot('handoff-note')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'handoff/task-x', title: '交接单：任务 X', content: '目标：…' })
    await memories.remember('workspace', workspace, { id: 'bugfix/other', title: 'Other', content: 'x' })

    const decision = await foldedDecision(ctx, stubAgent(workspace))
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('未完成任务交接单')
    expect(injected?.text).toContain('handoff/task-x')
    expect(injected?.text).toContain('memory read 读取并衔接继续')
  })

  it('skips handoff memos whose title marks them complete', async () => {
    const root = tempRoot('handoff-done')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'handoff/done-x', title: '交接单：任务 X — 已完成 ✅', content: '目标：…' })
    await memories.remember('workspace', workspace, { id: 'handoff/pending-y', title: '交接单：任务 Y', content: '目标：…' })

    const decision = await foldedDecision(ctx, stubAgent(workspace))
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('未完成任务交接单')
    expect(injected?.text).toContain('（handoff/）：handoff/pending-y')
    expect(injected?.text).not.toContain('（handoff/）：handoff/done-x')
  })

  it('skips archived nodes in the injected catalogue', async () => {
    const root = tempRoot('archive-skip')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'design/x', title: '过时方案', content: '已被推翻' })
    await memories.remember('workspace', workspace, { id: 'design/y', title: '现行方案', content: '在用' })
    await memories.archive('workspace', workspace, 'design/x')

    const decision = await foldedDecision(ctx, stubAgent(workspace))
    const injected = memoryMessages(decision)[0]
    expect(injected).toBeDefined()
    expect(injected?.text).toContain('- [design/y] 现行方案')
    expect(injected?.text).not.toContain('过时方案')
    expect(injected?.text).not.toContain('archive/design/x')
  })

  it('recalls relevant memory summaries from turn 2 on', async () => {
    const root = tempRoot('recall-basic')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'store 目录缺失导致 spawn 失败，已修复' })
    await memories.remember('workspace', workspace, { id: 'design/other', title: '无关设计', content: '某天的其他记录' })

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '这个 spawn 的问题怎么处理' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    expect(text).toContain('相关记忆')
    expect(text).toContain('bugfix/enoent')
    expect(text).not.toContain('design/other')
  })

  it('recalls from the recent tool result, not only the user prompt', async () => {
    const root = tempRoot('recall-tool')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'spawn 失败 ENOENT 找不到文件，store 目录缺失' })
    await memories.remember('workspace', workspace, { id: 'design/other', title: '无关设计', content: '无关内容' })

    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 1, surfaceOp: 'append',
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '开始处理' }] },
      },
      {
        type: 'tool/result', seq: 2, time: 1, surfaceOp: 'append',
        data: {
          message: {
            id: 't1', role: 'user', source: { kind: 'tool', name: 'pwsh', callId: 'c1' },
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'spawn 报错 ENOENT 找不到文件' }],
              toolCallId: 'c1',
            }],
          },
        },
      },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    // The user prompt itself carries no probe; the failing tool result does.
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '继续处理' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    expect(text).toContain('bugfix/enoent')
    expect(text).not.toContain('design/other')
  })

  it('prefers tool result keywords over earlier narration in recall queries', async () => {
    const root = tempRoot('recall-tool-first')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/alpha', title: 'Alpha', content: 'alpha 相关' })
    await memories.remember('workspace', workspace, { id: 'bugfix/beta', title: 'Beta', content: 'beta 相关' })

    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 1, surfaceOp: 'append',
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'alpha alpha 讨论' }] },
      },
      {
        type: 'tool/result', seq: 2, time: 1, surfaceOp: 'append',
        data: {
          message: {
            id: 't1', role: 'user', source: { kind: 'tool', name: 'pwsh', callId: 'c1' },
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'beta 报错' }],
              toolCallId: 'c1',
            }],
          },
        },
      },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    // The tool result's keyword (`beta`) must win the query budget over the
    // user narration's (`alpha`) — the tool result IS the execution context.
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '继续处理' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    expect(blocksText(recalls[0]?.content)).toContain('bugfix/beta')
  })

  it('reserves the user\'s intent words even when the context is noisy', async () => {
    const root = tempRoot('recall-user-first')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/recall', title: '联想修复', content: '记忆联想机制 bug 修复记录' })
    await memories.remember('workspace', workspace, { id: 'bugfix/other', title: '其他', content: '无关内容' })

    // The previous turn ends with a noisy tool summary and a long assistant
    // narration carrying a path — exactly the context that used to crowd the
    // user's own words out of the query budget entirely.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'tool/result', seq: 1, time: 1, surfaceOp: 'append',
        data: {
          message: {
            id: 't1', role: 'user', source: { kind: 'tool', name: 'pwsh', callId: 'c1' },
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'Found 0 warnings and 0 errors. Finished in 1.8s on 3 files with 89 rules using 20 threads' }],
              toolCallId: 'c1',
            }],
          },
        },
      },
      {
        type: 'user/message', seq: 2, time: 1, surfaceOp: 'append',
        data: {
          id: 'u1', role: 'user', source: { kind: 'model' },
          content: [{ type: 'text', text: '搞定啦。凛把 packages/memory/memory-accumulate/tsconfig.json 的构建问题全部收尾了' }],
        },
      },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    // The user's own words ("bug") are the intent; the noisy tool summary
    // ("found"/"warnings") and the long path must not crowd them out.
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '记忆联想机制好像没触发，是不是那个又卡出什么bug了' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    expect(text).toContain('bugfix/recall')
    expect(text).not.toContain('bugfix/other')
  })

  it('recalls from concrete entities in the latest reasoning block', async () => {
    const root = tempRoot('recall-reasoning-entities')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, {
      id: 'bugfix/session-corrupt', title: '会话日志损坏修复', content: 'session-38253fc8 日志损坏修复：seq 必须连续',
    })
    await memories.remember('workspace', workspace, { id: 'design/other', title: '无关设计', content: '无关内容' })

    // The agent's latest reasoning names the concrete session id it is about
    // to inspect — a grounded fact of the current thinking, not speculation.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'a1', role: 'assistant',
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [
              { type: 'reasoning', text: 'session-38253fc8 正是之前 resume 失败的那个会话。看看里面有什么。' },
              { type: 'text', text: '我看看那个会话的日志。' },
            ],
          },
        },
      },
      { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    // The user prompt itself carries no probe; the reasoning block's session
    // id must drive the recall.
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '继续处理' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    expect(text).toContain('bugfix/session-corrupt')
    expect(text).not.toContain('design/other')
  })

  it('keeps speculative reasoning wording out of recall queries', async () => {
    const root = tempRoot('recall-reasoning-speculation')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, {
      id: 'bugfix/enoent', title: '修复 ENOENT', content: 'spawn git ENOENT 找不到 git 可执行文件',
    })

    // Reasoning full of speculation ("可能/也许/大概") carries no concrete
    // entity; the user prompt carries no probe either — recall must stay quiet.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          message: {
            id: 'a1', role: 'assistant',
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [
              { type: 'reasoning', text: '这可能是环境问题，也许需要换个思路，大概再想想。' },
              { type: 'text', text: '我先继续。' },
            ],
          },
        },
      },
      { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    // No concrete entity in reasoning and no probe in the prompt: nothing to
    // retrieve, so no recall injection at all.
    expect(recalls).toHaveLength(0)
  })

  it('filters error-noise words out of recall queries', async () => {
    const root = tempRoot('recall-noise')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/alpha', title: 'Alpha', content: 'alpha 相关' })

    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'tool/result', seq: 1, time: 1, surfaceOp: 'append',
        data: {
          message: {
            id: 't1', role: 'user', source: { kind: 'tool', name: 'pwsh', callId: 'c1' },
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'SyntaxError: alpha is not supported' }],
              toolCallId: 'c1',
            }],
          },
        },
      },
      { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const agent = stubAgent(workspace, seed)
    const userMsg = createUserMessage({
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    // `syntaxerror` is noise; `alpha` (the real keyword) must carry the query.
    expect(blocksText(recalls[0]?.content)).toContain('bugfix/alpha')
  })

  it('injects keyword order directly when candidates fit the budget (zero LLM)', async () => {
    const root = tempRoot('recall-no-rerank')
    const workspace = join(root, 'ws')
    const adapter = new FakeAdapter([])
    const { ctx, memories } = await liveContext(join(root, 'central'), {}, adapter)
    await memories.remember('workspace', workspace, { id: 'bugfix/alpha', title: 'Alpha', content: 'alpha 相关' })
    await memories.remember('workspace', workspace, { id: 'bugfix/beta', title: 'Beta', content: 'beta 相关' })

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'alpha 问题' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    expect(blocksText(recalls[0]?.content)).toContain('bugfix/alpha')
    // Only one candidate matched, so no LLM re-rank call happened.
    expect(adapter.requests).toHaveLength(0)
  })

  it('re-ranks candidates with one LLM call when the keyword pass over-produces', async () => {
    const root = tempRoot('recall-rerank')
    const workspace = join(root, 'ws')
    // Five keyword matches (all share the probe word), only 3 fit the budget
    // — the re-rank judge picks which three.
    const adapter = new FakeAdapter([textChunks('bugfix/echo\nbugfix/alpha\nbugfix/charlie')])
    const { ctx, memories } = await liveContext(join(root, 'central'), { recallTopN: 3, recallCandidates: 10 }, adapter)
    for (const [id, content] of [
      ['bugfix/alpha', 'alpha shared 相关经验'],
      ['bugfix/beta', 'beta shared 相关经验'],
      ['bugfix/charlie', 'charlie shared 相关经验'],
      ['bugfix/delta', 'delta shared 相关经验'],
      ['bugfix/echo', 'echo shared 相关经验'],
    ] as const) {
      await memories.remember('workspace', workspace, { id, title: id, content })
    }

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'shared 问题，帮我看看' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    // The judge's picks come first; the top-3 budget is respected.
    expect(text.indexOf('bugfix/echo')).toBeLessThan(text.indexOf('bugfix/alpha'))
    expect(text.indexOf('bugfix/alpha')).toBeLessThan(text.indexOf('bugfix/charlie'))
    expect(text).not.toContain('bugfix/delta')
    expect(text).not.toContain('bugfix/beta')
    // Exactly one auxiliary LLM call for the re-rank.
    expect(adapter.requests).toHaveLength(1)
  })

  it('falls back to keyword order when the re-rank call fails', async () => {
    const root = tempRoot('recall-rerank-fail')
    const workspace = join(root, 'ws')
    const adapter = new FakeAdapter(['fail'])
    const { ctx, memories } = await liveContext(join(root, 'central'), { recallTopN: 2, recallCandidates: 10 }, adapter)
    for (const [id, content] of [
      ['bugfix/alpha', 'alpha shared 相关经验'],
      ['bugfix/beta', 'beta shared 相关经验'],
      ['bugfix/charlie', 'charlie shared 相关经验'],
    ] as const) {
      await memories.remember('workspace', workspace, { id, title: id, content })
    }

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'shared 问题，帮我看看' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    const recalls = decision.kind === 'enter'
      ? decision.messages.filter(message => message.source.kind === 'rin-memory-recall')
      : []
    expect(recalls).toHaveLength(1)
    const text = blocksText(recalls[0]?.content)
    // Re-rank failed, so the keyword order survives; 2 of 3 fit the budget.
    expect(text).toContain('bugfix/alpha')
    expect(text).toContain('bugfix/beta')
    expect(text).not.toContain('bugfix/charlie')
    // The failing re-rank consumed exactly one scripted call.
    expect(adapter.requests).toHaveLength(1)
  })

  it('does not repeat recalled memories in the same session', async () => {
    const root = tempRoot('recall-once')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'store 目录缺失导致 spawn 失败' })

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'spawn 报错了' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const first = await stepDecision(ctx, agent, [userMsg], 1, 2)
    expect(first.kind === 'enter' && first.messages.some(m => m.source.kind === 'rin-memory-recall')).toBe(true)
    const second = await stepDecision(ctx, agent, [userMsg], 1, 3)
    expect(second.kind === 'enter' && second.messages.some(m => m.source.kind === 'rin-memory-recall')).toBe(false)
  })

  it('recalls on every step of a multi-step turn, deduplicated per memory', async () => {
    const root = tempRoot('recall-steps')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/alpha', title: 'Alpha', content: 'alpha 相关' })
    await memories.remember('workspace', workspace, { id: 'bugfix/beta', title: 'Beta', content: 'beta 相关' })
    const agent = stubAgent(workspace)

    // Step 1: recall `alpha` from the user prompt.
    const msgA = createUserMessage({
      content: [{ type: 'text', text: 'alpha 问题' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const first = await stepDecision(ctx, agent, [msgA], 1, 2)
    const firstRecalls = first.kind === 'enter' ? first.messages.filter(m => m.source.kind === 'rin-memory-recall') : []
    expect(firstRecalls).toHaveLength(1)
    expect(blocksText(firstRecalls[0]?.content)).toContain('bugfix/alpha')
    // The loop persists the injection to the surface before the next step.
    for (const message of firstRecalls) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }

    // Step 2 of the same turn re-runs recall against the new context: `beta`
    // is recalled fresh, `alpha` is not repeated (session-level dedup).
    const msgB = createUserMessage({
      content: [{ type: 'text', text: 'beta 问题' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const second = await stepDecision(ctx, agent, [msgB], 2, 2)
    const secondRecalls = second.kind === 'enter' ? second.messages.filter(m => m.source.kind === 'rin-memory-recall') : []
    expect(secondRecalls).toHaveLength(1)
    const text = blocksText(secondRecalls[0]?.content)
    expect(text).toContain('bugfix/beta')
    expect(text).not.toContain('bugfix/alpha')
  })

  it('does not recall on turn 1, where the catalogue already covers memory', async () => {
    const root = tempRoot('recall-turn1')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'))
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'spawn 相关' })

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'spawn 问题' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 1)
    expect(decision.kind === 'enter' && decision.messages.some(m => m.source.kind === 'rin-memory-recall')).toBe(false)
    expect(decision.kind === 'enter' && decision.messages.some(m => m.source.kind === 'rin-memory')).toBe(true)
  })

  it('disables recall when recallTopN is 0', async () => {
    const root = tempRoot('recall-off')
    const workspace = join(root, 'ws')
    const { ctx, memories } = await liveContext(join(root, 'central'), { recallTopN: 0 })
    await memories.remember('workspace', workspace, { id: 'bugfix/enoent', title: '修复 ENOENT', content: 'spawn 相关' })

    const userMsg = createUserMessage({
      content: [{ type: 'text', text: 'spawn 问题' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const agent = stubAgent(workspace)
    const decision = await stepDecision(ctx, agent, [userMsg], 1, 2)
    expect(decision.kind === 'enter' && decision.messages.some(m => m.source.kind === 'rin-memory-recall')).toBe(false)
  })
})
