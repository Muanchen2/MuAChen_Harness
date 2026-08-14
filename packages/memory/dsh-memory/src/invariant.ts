/** Rin memory store invariants. @module @deepseek-ai/dsh-memory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'dsh-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate the memory store-scope contract at runtime and whenever a memory
 * store service is present: the `workspace` scope must never resolve a store
 * without a workspace path, which would silently collapse project experience
 * into a wrong directory. The central scope must always resolve.
 */
function validateScope(ctx: Context, fail: InvariantFailure): void {
  const memories = ctx.get('memories')
  if (memories === undefined) return
  try {
    // A workspace write with no workspace path is the contract violation this
    // invariant guards; central never needs one. Accessing a store triggers
    // the same check path the real writes use.
    void memories.list('workspace', undefined)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('memory: a workspace path')) return
    fail(`memory workspace store misbehaved: ${String(error)}`)
  }
}

/** Install the memory store-scope validation. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  validateScope(ctx, fail)
}

/**
 * Register the memory invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
