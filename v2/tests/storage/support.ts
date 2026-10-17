import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Normalizer, Privacy } from '../../capture/normalize.ts'
import { Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'

export const T0 = 1_792_130_000_000
export const MIN = 60_000
export const HOUR = 60 * MIN

export function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-storage-'))
}

export function open(dir = tmpDir(), now: () => number = () => T0) {
  const store = new Store(dir, { now })
  const storage = new Storage(store, dir, { now })
  const normalizer = new Normalizer(store, new Privacy(store.exclusions()))
  return { dir, store, storage, normalizer, close: () => store.close() }
}
