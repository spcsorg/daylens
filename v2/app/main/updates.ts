// Updates from the releases of spcsorg/daylens. Downloads run in the background and install when Daylens quits, or at
// once from the menu bar. Only a Developer ID–signed build updates itself: Squirrel.Mac installs a download only when it
// carries the running app's signature, which an ad-hoc build can never match.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

const FIRST_CHECK_MS = 10_000
const RECHECK_MS = 4 * 60 * 60 * 1000

export function developerIdSigned(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, '..', '..', '..')
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], (err, _out, details) => {
      resolve(!err && /^Authority=Developer ID Application: /m.test(details) && /^TeamIdentifier=[A-Z0-9]{10}$/m.test(details))
    })
  })
}

// electron-updater loads a lot of code; it stays out of launch.
async function updater() {
  return (await import('electron-updater')).default.autoUpdater
}

export function startUpdates(o: { log: (line: string) => void; onReady: (version: string) => void }): void {
  if (!app.isPackaged || process.platform !== 'darwin') return
  setTimeout(async () => {
    if (!(await developerIdSigned())) return o.log('updates off: this build is not Developer ID signed')
    const u = await updater()
    u.logger = null
    u.on('error', (err: Error) => o.log(`update failed ${err.message}`))
    u.on('update-downloaded', (info: { version: string }) => o.onReady(info.version))
    // A failed check is logged by the error handler above.
    const check = () => void u.checkForUpdates().catch(() => {})
    check()
    setInterval(check, RECHECK_MS).unref()
  }, FIRST_CHECK_MS).unref()
}

/** Quits into the downloaded update; Daylens ends here unless the install fails. */
export async function installUpdate(onFailed: (err: Error) => void): Promise<void> {
  const u = await updater()
  u.once('error', onFailed)
  u.quitAndInstall()
}
