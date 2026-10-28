// The nightly build on this Mac: fetches main, builds Daylens signed with the local identity (localSigning.ts),
// and swaps it into /Applications. A failed step keeps the app that was there. V1's data is never opened; its
// database's checksum is logged before and after to show it. Logs go to ~/Library/Logs/Daylens Nightly.
// Usage: node app/package/nightly.ts [--force] [--branch <b>]   one run now (--force builds even if the branch hasn't moved)
//        node app/package/nightly.ts --install [--branch <b>]   run every night at 04:00, and on the next wake if the Mac slept
//        node app/package/nightly.ts --uninstall
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { NIGHTLY_DIR, localIdentity } from './localSigning.ts'

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    install: { type: 'boolean', default: false },
    uninstall: { type: 'boolean', default: false },
    branch: { type: 'string', default: 'main' },
  },
})

const REPO = 'https://github.com/spcsorg/daylens.git'
const BRANCH = values.branch
// A rebuildable checkout, so it lives in Caches; node-gyp's make also breaks on the space in "Application Support".
const SOURCE = path.join(os.homedir(), 'Library', 'Caches', 'app.daylens.nightly', 'source')
const STATE = path.join(NIGHTLY_DIR, 'installed.json')
const PREVIOUS = path.join(NIGHTLY_DIR, 'previous', 'Daylens.app')
const APP = '/Applications/Daylens.app'
const APP_ID = 'com.daylens.desktop'
const HELPER = path.join(APP, 'Contents', 'Helpers', 'Daylens.app', 'Contents', 'MacOS', 'daylens-capture-macos')
const LOGS = path.join(os.homedir(), 'Library', 'Logs', 'Daylens Nightly')
const LABEL = 'app.daylens.nightly'
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
// V1 keeps its database here (src/main/services/userData.ts on main); nightly only reads it to checksum.
const V1_DB = path.join(os.homedir(), 'Library', 'Application Support', 'DaylensWindows', 'daylens.sqlite')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(LOGS, { recursive: true })
const runLog = path.join(LOGS, `${stamp}.log`)
const log = (line: string) => appendFileSync(runLog, `${new Date().toISOString()} ${line}\n`)
// One line per run, newest last: the file to read in the morning.
const summary = (line: string) => appendFileSync(path.join(LOGS, 'nightly.log'), `${new Date().toISOString()} ${line} (${runLog})\n`)

function sh(cmd: string, args: string[], cwd = SOURCE, env?: NodeJS.ProcessEnv): string {
  log(`$ ${cmd} ${args.join(' ')}`)
  try {
    const out = execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
    appendFileSync(runLog, out)
    return out
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    appendFileSync(runLog, `${e.stdout ?? ''}${e.stderr ?? ''}`)
    throw new Error(`${path.basename(cmd)} ${args[0]} failed`)
  }
}

const npm = path.join(path.dirname(process.execPath), 'npm')

async function sha256(file: string): Promise<string> {
  if (!existsSync(file)) return 'missing'
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function v1Sums(): Promise<string> {
  const sums = await Promise.all(['', '-wal', '-shm'].map(async (s) => `${path.basename(V1_DB)}${s}=${(await sha256(V1_DB + s)).slice(0, 16)}`))
  return sums.join(' ')
}

function pids(): number[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `^${APP}/`], { encoding: 'utf8' }).trim().split('\n').map(Number)
  } catch {
    return []
  }
}

async function quit(): Promise<void> {
  if (pids().length === 0) return
  sh('/usr/bin/osascript', ['-e', `if application id "${APP_ID}" is running then tell application id "${APP_ID}" to quit`], os.homedir())
  for (let i = 0; i < 40 && pids().length; i++) await sleep(500)
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids()) process.kill(pid, signal)
    for (let i = 0; i < 10 && pids().length; i++) await sleep(500)
  }
  if (pids().length) throw new Error('Daylens did not quit')
}

// The helper prints started=ax_granted or started=ax_denied as it starts; it checks its own grant, not its parent's.
function accessibility(): Promise<string> {
  return new Promise((resolve) => {
    // It quits when stdin closes, so stdin stays an open pipe.
    const child = spawn(HELPER, [], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    const done = (state: string) => {
      child.kill()
      resolve(state)
    }
    const timer = setTimeout(() => done('unknown'), 10_000)
    child.stderr.on('data', (d: Buffer) => {
      err += d
      const m = /started=ax_(granted|denied)/.exec(err)
      if (m) {
        clearTimeout(timer)
        done(m[1]!)
      }
    })
    child.on('error', () => done('unknown'))
  })
}

async function opened(): Promise<boolean> {
  try {
    execFileSync('/usr/bin/open', ['-g', APP])
  } catch {
    return false
  }
  const running = () => pids().length >= 2 && execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf8' }).includes(HELPER)
  for (let i = 0; i < 60 && !running(); i++) await sleep(500)
  if (!running()) return false
  // Still up after the first seconds, where a broken build crashes.
  await sleep(15_000)
  return running()
}

function notify(message: string): void {
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Daylens nightly"`])
  } catch {}
}

function update(): string {
  if (!existsSync(path.join(SOURCE, '.git'))) sh('/usr/bin/git', ['clone', REPO, SOURCE], os.homedir())
  sh('/usr/bin/git', ['fetch', 'origin', BRANCH])
  sh('/usr/bin/git', ['reset', '--hard', 'FETCH_HEAD'])
  sh('/usr/bin/git', ['clean', '-fd'])
  return sh('/usr/bin/git', ['rev-parse', 'HEAD']).trim()
}

function build(): string {
  const v2 = path.join(SOURCE, 'v2')
  const lockSum = createHash('sha256').update(readFileSync(path.join(v2, 'package-lock.json'))).digest('hex')
  const lockStamp = path.join(v2, 'node_modules', '.nightly-lock')
  if (!existsSync(lockStamp) || readFileSync(lockStamp, 'utf8') !== lockSum) {
    sh(npm, ['ci', '--no-audit', '--no-fund'], v2)
    writeFileSync(lockStamp, lockSum)
  }
  sh(npm, ['run', 'app:package', '--', '--dir'], v2, { DAYLENS_MAC_LOCAL_SIGN: '1' })
  const built = path.join(v2, 'build', 'release', 'mac-universal', 'Daylens.app')
  const helper = path.join(built, 'Contents', 'Helpers', 'Daylens.app')
  const requirement = execFileSync('/usr/bin/codesign', ['-d', '-r-', helper], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (!requirement.toLowerCase().includes(`certificate leaf = h"${localIdentity().hash.toLowerCase()}"`)) throw new Error('the helper is not signed with the local identity')
  return built
}

function swap(built: string): void {
  rmSync(path.dirname(PREVIOUS), { recursive: true, force: true })
  mkdirSync(path.dirname(PREVIOUS), { recursive: true })
  if (existsSync(APP)) renameSync(APP, PREVIOUS)
  try {
    sh('/usr/bin/ditto', [built, APP], os.homedir())
  } catch (err) {
    rollback()
    throw err
  }
}

function rollback(): void {
  rmSync(APP, { recursive: true, force: true })
  if (existsSync(PREVIOUS)) renameSync(PREVIOUS, APP)
}

async function run(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('nightly builds run on macOS only for now')
  const commit = update()
  const last = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as { commit: string }).commit : null
  if (!values.force && commit === last && existsSync(APP)) return `unchanged ${commit.slice(0, 8)}: kept the installed app`
  const built = build()
  await quit()
  swap(built)
  if (!(await opened())) {
    log('the new build did not stay open; putting the last good app back')
    await quit()
    rollback()
    await opened()
    throw new Error(`the build of ${commit.slice(0, 8)} did not stay open`)
  }
  writeFileSync(STATE, JSON.stringify({ commit, at: new Date().toISOString() }))
  return `installed ${commit.slice(0, 8)}; accessibility ${await accessibility()}`
}

function install(): void {
  update()
  const node = process.execPath
  // From the nightly's own clone, so each night runs the job as the branch has it.
  const args = [node, path.join(SOURCE, 'v2', 'app', 'package', 'nightly.ts'), '--branch', BRANCH]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${path.join(LOGS, 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOGS, 'launchd.log')}</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
`
  mkdirSync(path.dirname(PLIST), { recursive: true })
  const uid = String(process.getuid!())
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' })
  } catch {}
  writeFileSync(PLIST, plist)
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, PLIST])
  process.stdout.write(`installed ${PLIST}: runs at 04:00; logs in ${LOGS}\n`)
}

function uninstall(): void {
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' })
  } catch {}
  rmSync(PLIST, { force: true })
  process.stdout.write(`removed ${PLIST}\n`)
}

if (values.install) install()
else if (values.uninstall) uninstall()
else {
  const v1Before = await v1Sums()
  log(`v1 before ${v1Before}`)
  let line: string
  try {
    line = await run()
  } catch (err) {
    const message = (err as Error).message
    log(`failed: ${message}`)
    line = `FAILED: ${message}; kept the last good app`
    notify(`Nightly build failed: ${message}. The last good Daylens is still installed.`)
    process.exitCode = 1
  }
  const v1After = await v1Sums()
  log(`v1 after ${v1After}`)
  summary(`${line}; v1 database ${v1After === v1Before ? 'unchanged' : 'CHANGED'} (${v1After})`)
}
