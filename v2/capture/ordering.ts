import { execFile } from 'node:child_process'
import type { OrderingPoint } from './normalize.ts'

// A safety bound only: the first run after an update can take most of a second, and nothing the user sees waits on it.
export const ORDERING_READ_LIMIT_MS = 10_000

export function readOrderingPoint(helper: string, args: readonly string[], onError: (code: string) => void, timeoutMs = ORDERING_READ_LIMIT_MS): Promise<OrderingPoint | null> {
  return new Promise((resolve) => {
    execFile(helper, [...args, '--ordering-point'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
      try {
        if (error) throw new Error('clock unavailable')
        const p = JSON.parse(stdout) as OrderingPoint
        if (typeof p.boot !== 'string' || !p.boot || !Number.isSafeInteger(p.mono_us) || p.mono_us < 0 || !['kernel', 'clock'].includes(p.boot_identity)) throw new Error('invalid clock')
        resolve(p)
      } catch {
        onError('activation_clock_unavailable')
        resolve(null)
      }
    })
  })
}
