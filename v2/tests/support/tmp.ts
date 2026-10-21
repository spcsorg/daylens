// Temporary folders for tests. Each test file runs in its own process, so they are removed when that process exits.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const made = new Set<string>()

process.on('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      process.stderr.write(`test folder not removed: ${dir} (${(err as { code?: string }).code ?? 'failed'})\n`)
    }
  }
})

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  made.add(dir)
  return dir
}
