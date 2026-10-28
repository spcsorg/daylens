// Settings' actions.
import { app, nativeTheme } from 'electron'
import type { SettingsAction } from '../../shared/settings.ts'
import { capture, type ActionHandlers } from './context.ts'

export const settings: ActionHandlers<SettingsAction> = {
  unexclude: (ctx, a) => capture(ctx, { op: 'unexclude', match: a.match, value: a.value }),
  retention: (ctx, a) => capture(ctx, { op: 'retention', days: a.days }),
  login_item: async (ctx, a) => {
    app.setLoginItemSettings({ openAtLogin: a.on })
    ctx.pushShell()
    return app.getLoginItemSettings().openAtLogin === a.on ? { ok: true } : { ok: false, error: 'login_item_refused' }
  },
  appearance: async (ctx, a) => {
    nativeTheme.themeSource = a.mode
    ctx.savePrefs({ appearance: a.mode })
    ctx.pushShell()
    return { ok: true }
  },
}
