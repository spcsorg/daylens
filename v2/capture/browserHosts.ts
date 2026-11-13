import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CHROMIUM_EXTENSION_IDS } from './pairing.ts'

export const HOST_NAME = 'app.daylens.browser'
export const DEV_CHROMIUM_ID = 'dgidcofcmgnlicmmepgomalcdcbgjjjg'
export const FIREFOX_ID = 'browser@daylens.app'

export function hostManifest(kind: 'chromium' | 'firefox', hostPath: string): object {
  const base = { name: HOST_NAME, description: 'Daylens', path: path.resolve(hostPath), type: 'stdio' }
  return kind === 'firefox' ? { ...base, allowed_extensions: [FIREFOX_ID] } : { ...base, allowed_origins: CHROMIUM_EXTENSION_IDS.map(id => `chrome-extension://${id}/`) }
}

export function register(kind: 'chromium' | 'firefox', dir: string, hostPath: string): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${HOST_NAME}.json`)
  writeFileSync(file, JSON.stringify(hostManifest(kind, hostPath), null, 2) + '\n')
  return file
}

export function unregister(dir: string): void {
  rmSync(path.join(dir, `${HOST_NAME}.json`), { force: true })
}

const BROWSERS = [
  { name: 'Google Chrome', dir: ['Google', 'Chrome'] },
  { name: 'Microsoft Edge', dir: ['Microsoft Edge'] },
  { name: 'Arc', dir: ['Arc', 'User Data'] },
  { name: 'Dia', dir: ['Dia', 'User Data'] },
  { name: 'Firefox', dir: ['Firefox'] },
  { name: 'Chrome for Testing', dir: ['Google', 'Chrome for Testing'] },
]

export async function registerMacBrowserHosts(home: string, helper: string): Promise<string[]> {
  const support = path.join(home, 'Library', 'Application Support')
  const browsers = BROWSERS.filter(b => existsSync(path.join(support, ...b.dir)))
  try {
    await access(helper, constants.X_OK)
  } catch {
    return browsers.map(b => b.name)
  }
  const failed: string[] = []
  for (const browser of browsers) {
    const firefox = browser.name === 'Firefox'
    const dir = path.join(support, ...(firefox ? ['Mozilla'] : browser.dir), 'NativeMessagingHosts')
    const file = path.join(dir, `${HOST_NAME}.json`)
    const tmp = `${file}.tmp`
    try {
      const text = JSON.stringify(hostManifest(firefox ? 'firefox' : 'chromium', helper), null, 2) + '\n'
      if (await readFile(file, 'utf8').catch(() => null) === text) continue
      await mkdir(dir, { recursive: true })
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, file)
    } catch {
      failed.push(browser.name)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }
  return failed
}
