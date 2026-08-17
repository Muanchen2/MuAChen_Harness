/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */

import { createHash } from 'node:crypto'
import type { GenerateOptions } from './types.ts'
import type { ReasoningEffortId } from './brand.ts'

/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

// TODO(call-config-shape): Revisit which fields are epoch-level for cache reuse
// and where provider-specific request options belong.
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Mark one exact request object as assembled by dsh-agent-loop.
 * @param request - loop-owned request envelope before LLM dispatch.
 * @returns the same request object marked as created by the process-local agent loop.
 */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

/**
 * Test whether the exact request object was assembled by dsh-agent-loop.
 * @param request - request envelope observed at the LLM waterfall.
 * @returns whether {@link markAgentLoopRequest} recorded this object.
 */
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}

/** Names of request regions tracked by a request fingerprint. */
export type RequestFingerprintSegment = 'config' | 'system' | 'tools' | 'messages'

/** Redacted SHA-256 summaries of an assembled model request. */
export interface RequestFingerprint {
  readonly config: string
  readonly system: string
  readonly tools: string
  readonly messages: string
  readonly messageHashes: readonly string[]
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Hash an assembled request without retaining prompt or message text. */
export function fingerprintGenerateOptions(options: GenerateOptions): RequestFingerprint {
  const config = {
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stop: options.stop,
    purpose: options.purpose,
  }
  const messageHashes = options.messages.map(message => sha256(canonicalJson(message)))
  return Object.freeze({
    config: sha256(canonicalJson(config)),
    system: sha256(canonicalJson(options.system)),
    tools: sha256(canonicalJson(options.tools)),
    messages: sha256(canonicalJson(options.messages)),
    messageHashes: Object.freeze(messageHashes),
  })
}

/** Return the earliest changed segment, or the first changed message ordinal. */
export function firstFingerprintDifference(a: RequestFingerprint, b: RequestFingerprint): RequestFingerprintSegment | number | null {
  if (a.config !== b.config) return 'config'
  if (a.system !== b.system) return 'system'
  if (a.tools !== b.tools) return 'tools'
  for (let i = 0; i < Math.max(a.messageHashes.length, b.messageHashes.length); i++) if (a.messageHashes[i] !== b.messageHashes[i]) return i
  return a.messages === b.messages ? null : 'messages'
}

/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles,
 * so later mutation throws without imposing a JavaScript call-stack depth cap.
 * {@link AbortSignal} objects are deliberately skipped because they are the
 * request's live cancellation channel and freezing them breaks abort.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}
