// The one way to start Daylens on an invented world: seeds it into a throwaway folder and returns the environment that
// points every reader of this computer's own files (browser history, agent sessions, assistant configs, V1's settings)
// at that folder, with the stand-in helper reporting invented windows instead of the real ones. The demo, the
// end-to-end tests, the bench and the release check all launch through it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const V2 = path.resolve(import.meta.dirname, '..', '..')

// Daylens from source: Electron on the shell's entry point. Run `npm run app:build` first for the interface.
export const SOURCE = { command: createRequire(import.meta.url)('electron') as string, args: [path.join(V2, 'app', 'main', 'main.ts')] }

export interface WorldOptions {
  // Emptied and reused if given; otherwise a new folder in the system's temporary folder.
  root?: string
  // A world seed.ts knows; pricing by default.
  world?: string
  // An ISO time: the world is seeded as of it and the app launches with DAYLENS_TEST_NOW set to it.
  now?: string
  // Pinned for the seed and the app, so days and hours fall the same on every machine. null keeps this computer's own
  // time zone and language.
  zone?: string | null
  onboarded?: boolean
  appearance?: 'system' | 'light' | 'dark'
}

export interface World {
  root: string
  data: string
  home: string
  shell: string
  env: NodeJS.ProcessEnv
}

export function makeWorld(o: WorldOptions = {}): World {
  if (o.root) rmSync(o.root, { recursive: true, force: true })
  const root = o.root ?? mkdtempSync(path.join(os.tmpdir(), 'daylens-world-'))
  const data = path.join(root, 'data')
  const home = path.join(root, 'home')
  const shell = path.join(root, 'shell')
  for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, 'Documents'), shell]) mkdirSync(d, { recursive: true })
  // The stand-in helper's TextEdit window shows this file, so clicking it opens the file itself.
  writeFileSync(path.join(home, 'Documents', 'Pricing memo.txt'), 'Pricing memo: draft.\n')
  writeFileSync(path.join(shell, 'shell.json'), JSON.stringify({ onboarded: o.onboarded ?? true, appearance: o.appearance ?? 'system' }))

  const zone = o.zone === undefined ? 'America/Phoenix' : o.zone
  const { ELECTRON_RUN_AS_NODE: _node, DAYLENS_TEST_NOW: _now, DAYLENS_TEST_OFFSET_MS: _offset, ...inherited } = process.env
  const windows = process.platform === 'win32'
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...(zone !== null && { TZ: zone, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    ...(windows && { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') }),
    DAYLENS_V2_DATA_DIR: data,
    DAYLENS_SHELL_DIR: shell,
    DAYLENS_V2_HISTORY_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    DAYLENS_V2_BROWSER_SOCKET: windows ? `\\\\.\\pipe\\daylens-${path.basename(root)}` : path.join(root, 'browser.sock'),
    DAYLENS_HELPER: path.join(V2, 'app', 'tools', 'demo-helper.sh'),
    ...(o.now !== undefined && { DAYLENS_TEST_NOW: o.now }),
  }
  const seed = [path.join(V2, 'app', 'tools', 'seed.ts'), '--data-dir', data, '--world', o.world ?? 'pricing', ...(o.now !== undefined ? ['--now', o.now] : [])]
  execFileSync(process.execPath, seed, { env, stdio: ['ignore', 'ignore', 'inherit'] })
  return { root, data, home, shell, env }
}
