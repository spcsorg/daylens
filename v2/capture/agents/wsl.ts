// Agent logs inside WSL distributions on Windows, reached through \\wsl.localhost\<distribution>.
// Opening a path inside a stopped distribution starts it, so only distributions already running are ever touched.

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { homeRoots, type AgentRoot } from './reader.ts'

export type RunWsl = () => Promise<Buffer | null>

// `wsl.exe --list --running --quiet` lists running distributions only and does not start one.
export const runWslList: RunWsl = () =>
  new Promise((resolve) => {
    execFile('wsl.exe', ['--list', '--running', '--quiet'], { encoding: 'buffer', windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout))
  })

// wsl.exe writes UTF-16LE, sometimes with a byte order mark; older builds wrote UTF-8.
export function parseDistroList(out: Buffer): string[] {
  const utf16 = out.length >= 2 && (out[1] === 0 || (out[0] === 0xff && out[1] === 0xfe))
  const text = (utf16 ? out.toString('utf16le') : out.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '')
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[\\/]/.test(s))
}

export type ListDir = (dir: string) => Promise<string[]>
const listDir: ListDir = async (dir) => (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)

export class WslDiscovery {
  private running = new Set<string>()
  private readonly known = new Set<string>()
  private readonly run: RunWsl
  private readonly list: ListDir
  private readonly share: string

  constructor(run: RunWsl = runWslList, list: ListDir = listDir, share = '\\\\wsl.localhost') {
    this.run = run
    this.list = list
    this.share = share
  }

  isRunning(distro: string): boolean {
    return this.running.has(distro)
  }

  // Roots not seen before, for distributions running now. Roots of a distribution that stops stay known but unavailable.
  async discover(): Promise<AgentRoot[]> {
    const out = await this.run()
    this.running = new Set(out ? parseDistroList(out) : [])
    const fresh: AgentRoot[] = []
    for (const distro of this.running) {
      const base = path.win32.join(this.share, distro)
      let homes: string[] = []
      try {
        homes = (await this.list(path.win32.join(base, 'home'))).map((u) => path.win32.join(base, 'home', u))
      } catch {}
      homes.push(path.win32.join(base, 'root'))
      for (const home of homes) {
        for (const root of homeRoots(home, {})) {
          const dir = root.dir.split(path.posix.sep).join(path.win32.sep)
          if (this.known.has(dir)) continue
          this.known.add(dir)
          fresh.push({ ...root, dir, poll: true, available: () => this.running.has(distro) })
        }
      }
    }
    return fresh
  }
}
