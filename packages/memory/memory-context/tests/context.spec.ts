import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import MemoryService from '@deepseek-ai/dsh-memory'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
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
})
