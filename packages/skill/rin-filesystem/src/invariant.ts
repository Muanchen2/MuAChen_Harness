/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-rin-skill-filesystem`.
 * @module @deepseek-ai/dsh-rin-skill-filesystem/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-rin-skill-filesystem'

/** Cordis companion plugin name. */
export const name = 'rin-skill-filesystem-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the filesystem provider delegates catalog registration and lifecycle
 * ownership to `dsh-skill` and `dsh-skill-filesystem`.
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
