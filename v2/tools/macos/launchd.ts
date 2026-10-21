// Writes a launchd agent that runs the engine (capture, storage and agent-session reading) from this checkout at
// login and keeps it running. It installs and starts nothing; see README.md beside it.
// Usage: node tools/macos/launchd.ts [--out <file>] [--node <path>] [--data-dir <dir>]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

export const LABEL = 'app.daylens.engine'

const v2 = path.resolve(import.meta.dirname, '..', '..')
const { values } = parseArgs({ options: { out: { type: 'string' }, node: { type: 'string' }, 'data-dir': { type: 'string' } } })
const node = path.resolve(values.node ?? process.execPath)
const helper = path.join(v2, 'native', 'macos', '.build', 'release', 'daylens-capture-macos')
const logs = path.join(os.homedir(), 'Library', 'Logs', 'Daylens V2 Dev')
const out = path.resolve(values.out ?? path.join(v2, 'build', `${LABEL}.plist`))
for (const [what, file] of [['node', node], ['capture helper (swift build -c release in native/macos)', helper]] as const) {
  if (!existsSync(file)) throw new Error(`${what} not found: ${file}`)
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const args = [node, path.join(v2, 'capture', 'service.ts'), '--helper', helper, '--agent-sessions', ...(values['data-dir'] ? ['--data-dir', path.resolve(values['data-dir'])] : [])]
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(v2)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logs, 'engine.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logs, 'engine.log'))}</string>
</dict>
</plist>
`
mkdirSync(path.dirname(out), { recursive: true })
mkdirSync(logs, { recursive: true })
writeFileSync(out, plist)
process.stdout.write(`${out}\n`)
