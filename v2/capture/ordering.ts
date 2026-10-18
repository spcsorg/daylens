import { spawnSync } from 'node:child_process'
import type { OrderingPoint } from './normalize.ts'

export function readOrderingPoint(helper: string, args: readonly string[], onError: (code: string) => void): OrderingPoint | null {
  const result = spawnSync(helper, [...args, '--ordering-point'], { encoding: 'utf8', windowsHide: true })
  try {
    if (result.error || result.status !== 0) throw new Error('clock unavailable')
    const p = JSON.parse(result.stdout) as OrderingPoint
    if (typeof p.boot !== 'string' || !p.boot || !Number.isSafeInteger(p.mono_us) || p.mono_us < 0 || !['kernel', 'clock'].includes(p.boot_identity)) throw new Error('invalid clock')
    return p
  } catch {
    onError('activation_clock_unavailable')
    return null
  }
}
