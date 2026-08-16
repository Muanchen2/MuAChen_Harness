/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-skill-admin`.
 * @module @deepseek-ai/dsh-skill-admin/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-admin'

/** Cordis companion plugin name. */
export const name = 'skill-admin-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter owns no durable event/data
 * relation; execution semantics live in the git-backed skill stores it writes
 * and the tool registry it registers into.
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
