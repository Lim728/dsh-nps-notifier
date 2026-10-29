/** Lifetime-owned NPS forwarding for the packaged Web and Desktop composition. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeModule, RuntimeOwner } from './types.ts'

/** Cordis function plugin name. */
export const name = 'nps-notifier'
/** Profile-owned storage and the Loader tree are available before registration. */
export const inject = ['profileContext', 'loader']
/** Local NPS endpoint configuration; diagnostic storage is managed by the plugin. */
export interface Config {
  /** Local AiCliNotifier HTTP port; the destination is fixed to loopback. */
  port: number
}
/** Port selection never permits a remote destination. */
export const Config = z.object({ port: z.number().min(1).max(65535).step(1).default(17877) })

// Native ESM modules are retained during migration. Resolve their package-owned
// location identically from source, tsc declarations, and the bundled entry.
const packageRoot = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-host-nps-notifier/package.json'))

function isLegacy(entry: Entry): boolean {
  return !entry.disabled && (entry.options.id === 'nps-dsh-bounded-observer' || /(?:^|[/\\])nps-dsh-observer[/\\]observer\.mjs$/.test(entry.options.name))
}

declare module '@deepseek-ai/cordis' {
  interface Context { npsNotifier: NpsNotifierOwner }
}

/** A Cordis service prevents duplicate mounts from creating another forwarder. */
class NpsNotifierOwner extends Service {
  private readonly runtime: RuntimeOwner
  constructor(ctx: Context, config: Config & { runtime: RuntimeModule }) {
    super(ctx, 'npsNotifier')
    this.runtime = config.runtime.startBuiltin(ctx, { base: join(ctx.profileContext.dir, 'nps-notifier'), port: config.port })
    ctx.effect(() => () => { this.runtime.stop() })
    ctx.on('loader/patch-context', (entry, next) => {
      if (isLegacy(entry)) {
        this.runtime.stop()
        ctx.logger.warn('nps_notifier_stopped_legacy_adapter_enabled')
      }
      next()
    }, { global: true })
  }
}

/**
 * Register one owner without awaiting application readiness or NPS availability.
 * @param ctx - DSH profile context.
 * @param config - Validated local endpoint.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!ctx.get('appReady')) throw new Error('nps_notifier_requires_app_ready')
  for (const entry of ctx.loader.entries()) {
    if (isLegacy(entry)) {
      throw new Error('nps_notifier_legacy_adapter_enabled')
    }
  }
  const runtime = await import(pathToFileURL(join(packageRoot, 'runtime', 'observer.mjs')).href) as RuntimeModule
  await ctx.plugin(NpsNotifierOwner, { port: config.port, runtime })
}
