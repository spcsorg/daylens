// Settings' actions.
import { app, dialog, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { SettingsAction } from '../../shared/settings.ts'
import { capture, type ActionHandlers } from './context.ts'

export const settings: ActionHandlers<SettingsAction> = {
  unexclude: (ctx, a) => capture(ctx, { op: 'unexclude', match: a.match, value: a.value }),
  // An app chosen from Applications, so one never recorded can be kept out before it is.
  pick_app: async () => {
    const r = await dialog.showOpenDialog({ defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }], buttonLabel: 'Never record' })
    const file = r.filePaths[0]
    if (r.canceled || !file) return { ok: true, result: null }
    const id = await plist(file, 'CFBundleIdentifier')
    if (!id) return { ok: false, error: 'not_an_app' }
    return { ok: true, result: { id, name: (await plist(file, 'CFBundleDisplayName')) ?? (await plist(file, 'CFBundleName')) ?? path.basename(file, '.app') } }
  },
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

function plist(app: string, key: string): Promise<string | null> {
  return new Promise((resolve) => execFile('plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { timeout: 5000 }, (err, out) => resolve(err || !out.trim() ? null : out.trim())))
}
