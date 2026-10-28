// The menu bar item. Its menu is built when clicked, from the current hour as the reader sees it, so nothing refreshes it
// in the background.
import { Menu, Tray, dialog, nativeImage, type MenuItemConstructorOptions } from 'electron'

export interface TrayNow {
  title: string
  summary: string
  paused: { until_ms: number | null } | null
}

export interface TrayActions {
  now: () => Promise<TrayNow>
  pause: (until: 'hour' | 'tomorrow' | 'until_resumed') => Promise<boolean>
  resume: () => Promise<boolean>
  deleteLastTenMinutes: () => Promise<boolean>
  openToday: () => void
  // The version downloaded and waiting to install, if any.
  update: () => string | null
  restartToUpdate: () => void
  quit: () => void
}

const failed = (message: string) => void dialog.showMessageBox({ type: 'error', message, detail: 'Try again from Settings › Recording & privacy.' })

export function createTray(iconPath: string, actions: TrayActions): Tray {
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  tray.setToolTip('Daylens')
  tray.setIgnoreDoubleClickEvents(true)
  const open = async () => {
    let now: TrayNow
    try {
      now = await actions.now()
    } catch {
      now = { title: 'Daylens', summary: '', paused: null }
    }
    const items: MenuItemConstructorOptions[] = [{ label: now.title, enabled: false }]
    if (now.summary) items.push({ label: now.summary, enabled: false })
    items.push({ type: 'separator' })
    if (now.paused) {
      items.push({ label: 'Resume', click: async () => (await actions.resume()) || failed('Daylens couldn’t resume recording.') })
    } else {
      items.push(
        { label: 'Pause for 1 hour', click: async () => (await actions.pause('hour')) || failed('Daylens couldn’t pause. It is still recording.') },
        { label: 'Pause until tomorrow', click: async () => (await actions.pause('tomorrow')) || failed('Daylens couldn’t pause. It is still recording.') },
        { label: 'Pause until I resume', click: async () => (await actions.pause('until_resumed')) || failed('Daylens couldn’t pause. It is still recording.') },
      )
    }
    items.push(
      { type: 'separator' },
      {
        label: 'Delete the last 10 minutes',
        click: async () => {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            message: 'Delete the last 10 minutes?',
            detail: 'Everything Daylens recorded in the last 10 minutes is deleted from this computer.',
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          })
          if (response !== 0) return
          const ok = await actions.deleteLastTenMinutes()
          if (!ok) failed('Daylens couldn’t delete the last 10 minutes.')
        },
      },
      { type: 'separator' },
      { label: 'Open Today', click: () => actions.openToday() },
    )
    if (actions.update()) items.push({ label: 'Restart to Update', click: () => actions.restartToUpdate() })
    items.push({ label: 'Quit Daylens', accelerator: 'Command+Q', click: () => actions.quit() })
    tray.popUpContextMenu(Menu.buildFromTemplate(items))
  }
  tray.on('click', () => void open())
  tray.on('right-click', () => void open())
  return tray
}
