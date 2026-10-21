import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Normalizer, Privacy, type OrderingPoint } from '../../capture/normalize.ts'
import type { Line } from '../../capture/protocol.ts'
import { Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'
import { tempDir } from '../support/tmp.ts'

export const T0 = 1_792_130_400_000 // an hour boundary in Africa/Kigali (UTC+2)
export const MIN = 60_000
export const HOUR = 60 * MIN

export function tmpDir(): string {
  return tempDir('daylens-v2-storage-')
}

/** A store, storage and normalizer wired the way the capture service wires them, on a clock the test moves. */
export function rig(dir = tmpDir(), opts: { holdDeletions?: boolean; onError?: (code: string) => void; orderingPoint?: () => Promise<OrderingPoint | null> } = {}) {
  const clock = { t: T0, boot: 'boot-test', monoUs: null as number | null, bootIdentity: 'kernel' as 'kernel' | 'clock' }
  const now = () => clock.t
  const store = new Store(dir, { now })
  const storage = new Storage(store, dir, { now, holdDeletions: opts.holdDeletions, onError: opts.onError, orderingPoint: opts.orderingPoint ?? (() => ({ boot: clock.boot, mono_us: clock.monoUs ?? clock.t * 1000, boot_identity: clock.bootIdentity })) })
  let normalizer = new Normalizer(store, new Privacy(store.exclusions()))
  storage.attachCapture({
    interrupt: () => normalizer.interrupt({ wall_ms: clock.t, mono_us: null, boot: null }),
    setPrivacy: (privacy) => normalizer.setPrivacy(privacy),
  })
  const feed = (l: Line) => {
    clock.t = Math.max(clock.t, l.t.wall_ms)
    normalizer.handle(l)
  }
  const q = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => {
    store.flush()
    return store.query<T>(sql, ...params)
  }
  return {
    dir,
    clock,
    store,
    storage,
    get normalizer() {
      return normalizer
    },
    reopenNormalizer: () => {
      normalizer = new Normalizer(store, new Privacy(store.exclusions(), undefined, storage.keptTitleApps(), { boot: clock.boot, mono_us: clock.monoUs ?? clock.t * 1000, boot_identity: clock.bootIdentity }))
      return normalizer
    },
    feed,
    q,
    close: () => {
      storage.stop()
      store.close()
    },
  }
}

/** Every byte the database keeps on disk: the main file, the write-ahead log and the shared-memory index. */
export function diskContains(dir: string, needle: string): string[] {
  const hits: string[] = []
  const variants = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')]
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('daylens-v2.sqlite')) continue
    let bytes: Buffer
    try {
      bytes = readFileSync(path.join(dir, f))
    } catch {
      // The deletion worker's connection may close (removing -wal and -shm) while this lists the directory.
      continue
    }
    if (variants.some((v) => bytes.includes(v))) hits.push(f)
  }
  return hits
}
