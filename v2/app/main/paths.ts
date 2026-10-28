import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'

// From source this is v2/; packaged it is the compiled copy of v2/ inside app.asar, laid out the same way.
const V2 = path.resolve(import.meta.dirname, '..', '..')
const EXT = path.extname(import.meta.filename)
// The capture helper ships as its own app bundle, so System Settings lists it by name and icon.
const HELPER_APP = path.join(process.resourcesPath, '..', 'Helpers', 'Daylens.app')

// Packaged builds keep their data apart from runs from source, so the two never contend for one database.
const DATA_NAME = app.isPackaged ? 'Daylens V2' : 'Daylens V2 Dev'

// The same folder capture/store.ts's defaultDataDir picks for runs from source; repeated here so the shell never loads
// the database driver.
export function dataDir(): string {
  if (process.env.DAYLENS_V2_DATA_DIR) return process.env.DAYLENS_V2_DATA_DIR
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', DATA_NAME)
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), DATA_NAME)
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), DATA_NAME.toLowerCase().replaceAll(' ', '-'))
}

export const paths = {
  shellName: `${DATA_NAME} Shell`,
  service: path.join(V2, 'capture', `service${EXT}`),
  mcpServer: path.join(V2, 'mcp', `main${EXT}`),
  reader: path.join(V2, 'app', 'reader', `main${EXT}`),
  preload: path.join(V2, 'app', 'preload', 'preload.cjs'),
  renderer: path.join(V2, 'app', 'renderer', 'dist', 'index.html'),
  helper: process.env.DAYLENS_HELPER ?? (app.isPackaged ? path.join(HELPER_APP, 'Contents', 'MacOS', 'daylens-capture-macos') : path.join(V2, 'native', 'macos', '.build', 'release', 'daylens-capture-macos')),
  // What onboarding's drag tile hands to System Settings › Accessibility.
  helperDrag: process.env.DAYLENS_HELPER ?? (app.isPackaged ? HELPER_APP : path.join(V2, 'native', 'macos', '.build', 'release', 'daylens-capture-macos')),
  trayIcon: app.isPackaged ? path.join(process.resourcesPath, 'trayTemplate.png') : path.join(V2, '..', 'build', 'trayTemplate.png'),
  appIcon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(V2, '..', 'build', 'icon.png'),
  prefs: () => path.join(app.getPath('userData'), 'shell.json'),
}
