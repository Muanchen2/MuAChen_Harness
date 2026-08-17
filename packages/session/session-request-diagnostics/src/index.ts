/**
 * Optional process-local request diagnostics. It observes transient agent
 * request fingerprints and usage events, then appends redacted JSONL records
 * through a non-blocking queue. It never changes the session event vocabulary.
 *
 * @module @deepseek-ai/dsh-session-request-diagnostics
 */

import { appendFile } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestFingerprint, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'

/** Plugin configuration. Omission disables the collector; a path is required when enabled. */
export interface Config { path?: string }

/** Runtime config schema. */
export const Config: z<Config> = z.object({
  path: z.string(),
})

interface FingerprintRecord {
  kind: 'request-fingerprint'
  time: number
  sessionId: string
  turn: number
  step: number
  fingerprint: RequestFingerprint
}

interface UsageRecord {
  kind: 'request-usage'
  time: number
  sessionId: string
  turn: number
  step: number
  usage: TokenUsage
}

type RecordValue = FingerprintRecord | UsageRecord

/** Non-blocking JSONL writer with best-effort warnings and disposal drain. */
export class JsonlRequestDiagnostics {
  private readonly queue: string[] = []
  private writing = false
  private disposed = false
  private ready: Promise<void>

  /**
   * @param ctx - context used for contained warnings.
   * @param path - explicit JSONL destination.
   */
  constructor(private readonly ctx: Context, private readonly path: string) {
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => undefined).catch((error) => {
      this.warn(error)
    })
  }

  /** Enqueue one record without waiting for filesystem I/O. */
  emit(record: RecordValue): void {
    if (this.disposed) return
    this.queue.push(`${JSON.stringify(record)}\n`)
    this.pump()
  }

  /** Drain queued appends; failures are warnings and do not reject disposal. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.ready
    while (this.writing || this.queue.length > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }

  private pump(): void {
    if (this.writing || this.queue.length === 0) return
    this.writing = true
    const batch = this.queue.splice(0).join('')
    void this.ready.then(() => new Promise<void>((resolve, reject) => {
      appendFile(this.path, batch, 'utf8', error => error === null ? resolve() : reject(error))
    })).catch(error => this.warn(error)).finally(() => {
      this.writing = false
      this.pump()
    })
  }

  private warn(error: unknown): void {
    this.ctx.logger.warn(`request diagnostics: JSONL append failed: ${String(error)}`)
  }
}

/** Cordis plugin name. */
export const name = 'session-request-diagnostics'
/** Agent service is needed for scoped diagnostic events. */
export const inject = ['agents']

/** Mount the disabled-by-default collector when an explicit path is configured. */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.path === undefined || config.path.length === 0) return
  const writer = new JsonlRequestDiagnostics(ctx, config.path)
  ctx.on('agent/request-fingerprint', ({ agent, turn, step, fingerprint }) => {
    writer.emit({ kind: 'request-fingerprint', time: Date.now(), sessionId: String(agent.session.id), turn, step, fingerprint })
  })
  ctx.on('agent/request-usage', ({ agent, turn, step, usage }) => {
    writer.emit({ kind: 'request-usage', time: Date.now(), sessionId: String(agent.session.id), turn, step, usage })
  })
  ctx.effect(() => () => { void writer.dispose() }, 'request diagnostics JSONL')
}
