/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-context`.
 * @module @deepseek-ai/dsh-memory-context/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-context'

/** Cordis companion plugin name. */
export const name = 'memory-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the injection owns no durable event/data relation.
 * The rendered context rides the agent inbox (`agent/inbox/spliced` is the
 * inbox's own event), and the memory content lives in the `dsh-memory`
 * store, whose own companion owns that relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
