import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import MemoryService from '../../dsh-memory/src/index.ts'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
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

async function liveContext(
  centralRoot: string,
  config: memoryContext.Config = {},
): Promise<{ ctx: Context; memories: MemoryService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(MemoryService, { centralRoot })
  await ctx.plugin(memoryContext, config)
  return { ctx, memories: ctx.memories }
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
