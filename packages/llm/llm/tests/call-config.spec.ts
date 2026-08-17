/**
 * call-config unit tests: field-wise LlmCallConfig equality (the real-change
 * detector behind logged changed headers) and the deepFreeze ownership helper
 * the loop applies to every built request.
 */

import { describe, expect, it } from 'vitest'
import { callConfigEquals, deepFreeze, firstFingerprintDifference, fingerprintGenerateOptions, isAgentLoopRequest, markAgentLoopRequest } from '../src/call-config.ts'
import { MessageId, ReasoningEffortId } from '../src/brand.ts'
import type { GenerateOptions } from '../src/types.ts'

describe('request fingerprints', () => {
  const base = { provider: 'p', model: 'm', messages: [{ id: MessageId('1'), role: 'user' as const, content: [{ type: 'text' as const, text: 'secret prompt' }], source: { kind: 'user' as const } }] }
  it('is stable and excludes raw text', () => {
    const fingerprint = fingerprintGenerateOptions(base)
    expect(fingerprintGenerateOptions({ ...base, messages: [...base.messages] })).toEqual(fingerprint)
    expect(JSON.stringify(fingerprint)).not.toContain('secret prompt')
  })
  it('isolates segment changes and identifies the first changed message', () => {
    expect(firstFingerprintDifference(fingerprintGenerateOptions(base), fingerprintGenerateOptions({ ...base, system: 'system' }))).toBe('system')
    expect(firstFingerprintDifference(fingerprintGenerateOptions(base), fingerprintGenerateOptions({ ...base, tools: [{ name: 't', description: 'd', parameters: {} }] }))).toBe('tools')
    const changed = { ...base, messages: [...base.messages, { ...base.messages[0]!, id: MessageId('2') }] }
    expect(firstFingerprintDifference(fingerprintGenerateOptions(base), fingerprintGenerateOptions(changed))).toBe(1)
  })
  it('is stable across object key order', () => {
    const a = { ...base, tools: [{ name: 't', description: 'd', parameters: { z: 1, a: 2 } }] }
    const b = { ...base, tools: [{ parameters: { a: 2, z: 1 }, description: 'd', name: 't' }] }
    expect(fingerprintGenerateOptions(a)).toEqual(fingerprintGenerateOptions(b))
  })
})

describe('callConfigEquals', () => {
  it('compares every field, including the stop list element-wise', () => {
    const base = { provider: 'p', model: 'm' }
    expect(callConfigEquals(base, base)).toBe(true)
    expect(callConfigEquals(base, { provider: 'x', model: 'm' })).toBe(false)
    expect(callConfigEquals(base, { provider: 'p', model: 'x' })).toBe(false)
    expect(callConfigEquals({ ...base, reasoningEffort: ReasoningEffortId('high') }, base)).toBe(false)
    expect(callConfigEquals(
      { ...base, reasoningEffort: ReasoningEffortId('high') },
      { ...base, reasoningEffort: ReasoningEffortId('high') },
    )).toBe(true)
    expect(callConfigEquals({ ...base, temperature: 0.5 }, base)).toBe(false)
    expect(callConfigEquals({ ...base, maxTokens: 1 }, { ...base, maxTokens: 2 })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, base)).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['a', 'b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a', 'b'] }, { ...base, stop: ['a', 'b'] })).toBe(true)
  })
})

describe('deepFreeze', () => {
  it('freezes nested structure in place and returns the same reference', () => {
    const value = { a: { b: [1, { c: 'x' }] } }
    const frozen = deepFreeze(value)
    expect(frozen).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a.b)).toBe(true)
    expect(Object.isFrozen(value.a.b[1])).toBe(true)
    // ESM runs in strict mode: mutation throws rather than silently failing.
    expect(() => { (value.a.b[1] as { c: string }).c = 'y' }).toThrow(TypeError)
  })

  it('never freezes an AbortSignal: the live cancellation channel keeps working', () => {
    const controller = new AbortController()
    const request = deepFreeze({ model: 'm', signal: controller.signal })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
    let fired = false
    controller.signal.addEventListener('abort', () => { fired = true }, { once: true })
    controller.abort('stop')
    expect(fired).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it('passes primitives through and terminates on cycles', () => {
    expect(deepFreeze(42)).toBe(42)
    expect(deepFreeze(null)).toBeNull()
    const cyclic = { self: undefined as unknown }
    cyclic.self = cyclic
    deepFreeze(cyclic)
    expect(Object.isFrozen(cyclic)).toBe(true)
  })

  it('freezes nesting deeper than the JavaScript call stack', () => {
    const depth = 5_000
    const root: unknown[] = []
    let cursor = root
    for (let index = 0; index < depth; index++) {
      const child: unknown[] = []
      cursor.push(child)
      cursor = child
    }

    deepFreeze(root)

    cursor = root
    for (let index = 0; index < depth; index++) {
      expect(Object.isFrozen(cursor)).toBe(true)
      cursor = cursor[0] as unknown[]
    }
    expect(Object.isFrozen(cursor)).toBe(true)
  })
})

describe('agent-loop request identity', () => {
  it('marks only the exact request object and preserves its identity', () => {
    const request: GenerateOptions = {
      provider: 'mock',
      model: 'model',
      messages: [],
    }
    const copy = { ...request }

    expect(isAgentLoopRequest(request)).toBe(false)
    expect(markAgentLoopRequest(request)).toBe(request)
    expect(isAgentLoopRequest(request)).toBe(true)
    expect(isAgentLoopRequest(copy)).toBe(false)
  })
})
