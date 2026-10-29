/** Typed Loader-facing interface of the migrated native-ESM implementation. */
import type { Context } from '@deepseek-ai/cordis'

/** Disposal cancels the pending startup callback or the mounted runtime. */
export interface RuntimeOwner { stop(): void }
/** Private package runtime; no session content crosses this interface. */
export interface RuntimeModule {
  /**
   * Bind the lifetime to the current DSH profile.
   * @param ctx - Application context with launcher readiness.
   * @param options - Profile-owned diagnostic storage and loopback port.
   * @returns The idempotent disposal owner.
   */
  startBuiltin(ctx: Context, options: { base: string; port: number }): RuntimeOwner
}
