// Writes (or removes) the native messaging host manifest for the dev build, in the folder a browser reads it from.
// Chromium browsers read <user data dir>/NativeMessagingHosts, so a test profile keeps a real profile untouched.
// Firefox on macOS reads only ~/Library/Application Support/Mozilla/NativeMessagingHosts.
// Usage: node browser/tools/register.ts --kind chromium|firefox --dir <folder> --host <helper binary> [--remove]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

export const HOST_NAME = 'app.daylens.browser'
export const DEV_CHROMIUM_ID = 'dgidcofcmgnlicmmepgomalcdcbgjjjg'
export const FIREFOX_ID = 'browser@daylens.app'

export function hostManifest(kind: 'chromium' | 'firefox', hostPath: string): object {
  const base = { name: HOST_NAME, description: 'Daylens', path: path.resolve(hostPath), type: 'stdio' }
  return kind === 'firefox' ? { ...base, allowed_extensions: [FIREFOX_ID] } : { ...base, allowed_origins: [`chrome-extension://${DEV_CHROMIUM_ID}/`] }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { kind: { type: 'string' }, dir: { type: 'string' }, host: { type: 'string' }, remove: { type: 'boolean', default: false } } })
  if (values.remove) unregister(values.dir!)
  else process.stdout.write(register(values.kind as 'chromium' | 'firefox', values.dir!, values.host!) + '\n')
}
