/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-accumulate`.
 * @module @deepseek-ai/dsh-memory-accumulate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-accumulate'

/** Cordis companion plugin name. */
export const name = 'memory-accumulate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns no durable event/data relation — the
 * candidate prompt rides the agent inbox as a user message (`agent/inbox/
 * spliced` is the inbox's own event), and the judgment is an auxiliary LLM
 * call with no logged state of its own.
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
