// Fails when any executable or library in an app bundle has no arm64 slice: macOS warns about an app holding one, even
// if Apple silicon never loads it.
// Usage: node app/package/arm64.ts <Daylens.app>
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

const MACHO = new Set(['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf'])

export function assertArm64(app: string): void {
  // Framework symlinks reach the same files more than once.
  const files = new Set(readdirSync(app, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => realpathSync(path.join(e.parentPath, e.name))))
  let checked = 0
  for (const file of files) {
    const head = Buffer.alloc(4)
    const fd = openSync(file, 'r')
    const n = readSync(fd, head, 0, 4, 0)
    closeSync(fd)
    if (n < 4 || !MACHO.has(head.toString('hex'))) continue
    const archs = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(' ')
    if (!archs.includes('arm64')) throw new Error(`no arm64 slice (${archs.join(' ')}): ${path.relative(app, file)}`)
    checked++
  }
  process.stdout.write(`every Mach-O has arm64: ${checked} files\n`)
}

if (import.meta.main) assertArm64(path.resolve(process.argv[2]!))
