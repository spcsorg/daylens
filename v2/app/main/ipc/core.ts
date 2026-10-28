// Actions more than one screen, the menu bar or the shell sends.
import { shell } from 'electron'
import type { Action } from '../../shared/types.ts'
import { capture, type ActionHandlers } from './context.ts'

type CoreAction = Extract<Action, { a: 'pause' | 'resume' | 'delete' | 'exclude' | 'open_url' | 'open_app' | 'open_settings_privacy' | 'restart_capture' | 'bench' }>

export const core: ActionHandlers<CoreAction> = {
  pause: (ctx, a) => capture(ctx, { op: 'pause', until: a.until }),
  resume: (ctx) => capture(ctx, { op: 'resume' }),
  delete: async (ctx, a) => {
    if (a.never) {
      const r = await capture(ctx, { op: 'exclude', rule: a.never })
      if (!r.ok) return r
    }
    return capture(ctx, { op: 'delete', what: a.what }, (state) => {
      if (state === 'failed') ctx.win()?.webContents.send('deletion_failed')
    })
  },
  exclude: (ctx, a) => capture(ctx, { op: 'exclude', rule: a.rule }),
  open_url: async (_ctx, a) => {
    const url = new URL(a.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'not_a_web_address' }
    await shell.openExternal(url.toString())
    return { ok: true }
  },
  open_app: async (ctx, a) => {
    const p = await ctx.query<string | null>({ q: 'app_path', id: a.id }).catch(() => null)
    if (!p) return { ok: false, error: 'app_not_found' }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  },
  open_settings_privacy: async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    return { ok: true }
  },
  restart_capture: async (ctx) => {
    ctx.capture.restart()
    return { ok: true }
  },
  bench: async (ctx, a) => {
    process.stdout.write(`DAYLENS_BENCH ${JSON.stringify(a.marks)}\n`)
    setTimeout(() => ctx.quit(), 50)
    return { ok: true }
  },
}
