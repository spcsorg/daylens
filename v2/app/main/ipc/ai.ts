// The person's own Anthropic key: saved encrypted by the platform's secure storage, checked with Anthropic before it
// is saved, and handed to the reader (Ask) and capture (hours) whenever it changes. No action returns it.
import { safeStorage } from 'electron'
import path from 'node:path'
import { checkKey } from '../../../engine/backends.ts'
import { keyStore, KeyStoreError, type KeyStore } from '../../../retrieval/apiKey.ts'
import type { AiAction, AiStatus } from '../../shared/ai.ts'
import type { ActionResult } from '../../shared/types.ts'
import { dataDir } from '../paths.ts'
import type { ActionHandlers } from './context.ts'

const CHECK_TIMEOUT_MS = 15_000

let store: KeyStore | null = null
// safeStorage can be used only once the app is ready, so the store is made on first use.
const keys = () => (store ??= keyStore(path.join(dataDir(), 'anthropic-key'), safeStorage))

const listeners = new Set<(key: string | null) => void>()

export function onKeyChange(fn: (key: string | null) => void): void {
  listeners.add(fn)
}

export function savedKey(): string | null {
  try {
    return keys().load()
  } catch {
    return null
  }
}

function changed(): void {
  const key = savedKey()
  for (const fn of listeners) fn(key)
}

async function check(key: string): Promise<string | null> {
  const err = await checkKey({ apiKey: key, timeoutMs: CHECK_TIMEOUT_MS })
  if (err === null) return null
  return err === 'the API key was refused' ? 'Anthropic didn’t accept this key. Check it and try again.' : `Couldn’t reach Anthropic to check the key (${err}).`
}

const failed = (err: unknown): ActionResult => ({ ok: false, error: err instanceof KeyStoreError ? err.message : 'The key couldn’t be saved.' })

export const ai: ActionHandlers<AiAction> = {
  ai_status: async () => {
    try {
      return { ok: true, result: { saved: keys().load() !== null } satisfies AiStatus }
    } catch (err) {
      return failed(err)
    }
  },
  ai_key_save: async (_ctx, a) => {
    const key = a.key.trim()
    if (!key) return { ok: false, error: 'Paste your Anthropic API key first.' }
    const err = await check(key)
    if (err) return { ok: false, error: err }
    try {
      keys().save(key)
    } catch (e) {
      return failed(e)
    }
    changed()
    return { ok: true }
  },
  ai_key_test: async () => {
    const key = savedKey()
    if (!key) return { ok: false, error: 'No key is saved.' }
    const err = await check(key)
    return err ? { ok: false, error: err } : { ok: true }
  },
  ai_key_clear: async () => {
    keys().clear()
    changed()
    return { ok: true }
  },
}
