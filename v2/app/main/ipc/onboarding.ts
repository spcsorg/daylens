// Onboarding's actions.
import { app } from 'electron'
import type { OnboardingAction } from '../../shared/onboarding.ts'
import { paths } from '../paths.ts'
import type { ActionHandlers } from './context.ts'

export const onboarding: ActionHandlers<OnboardingAction> = {
  drag_helper: async (ctx) => {
    ctx.win()?.webContents.startDrag({ file: paths.helperDrag, icon: paths.appIcon })
    return { ok: true }
  },
  onboarded: async (ctx) => {
    ctx.savePrefs({ onboarded: true })
    if (app.isPackaged && !app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: true })
    ctx.pushShell()
    return { ok: true }
  },
}
