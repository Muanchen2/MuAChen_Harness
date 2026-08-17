/** Package-owned invariant companion for request diagnostics. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-session-request-diagnostics'
export const name = 'session-request-diagnostics-invariant'
export const inject = ['invariants']
/** No runtime invariant: this plugin observes transient events and writes an external diagnostic copy. */
const install: InvariantInstaller = () => {}
/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
