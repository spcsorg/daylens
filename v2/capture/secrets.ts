// Pairing secrets live in the platform's secure storage, never in the database: the macOS Keychain or the Windows
// Credential Manager, through the capture helper's --secret mode. The secret travels on stdin and stdout only.

import { execFile } from 'node:child_process'

export interface SecretStore {
  set(name: string, secret: string): Promise<void>
  get(name: string): Promise<string | null>
  delete(name: string): Promise<void>
}

const NAME_RE = /^[A-Za-z0-9_-]{22}$/
// The helper exits with this when the item does not exist.
const NOT_FOUND = 2

function run(helper: string, args: string[], input: string | null): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(helper, args, { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      if (code === -1) return reject(new Error('secret helper failed'))
      resolve({ code, stdout })
    })
    child.stdin?.end(input ?? '')
  })
}

export function helperSecrets(helperPath: string): SecretStore {
  const check = (name: string) => {
    if (!NAME_RE.test(name)) throw new Error('bad secret name')
  }
  return {
    async set(name, secret) {
      check(name)
      const r = await run(helperPath, ['--secret', 'set', name], secret + '\n')
      if (r.code !== 0) throw new Error(`secret set failed code=${r.code}`)
    },
    async get(name) {
      check(name)
      const r = await run(helperPath, ['--secret', 'get', name], null)
      if (r.code === NOT_FOUND) return null
      if (r.code !== 0) throw new Error(`secret get failed code=${r.code}`)
      return r.stdout.replace(/\n$/, '')
    },
    async delete(name) {
      check(name)
      const r = await run(helperPath, ['--secret', 'delete', name], null)
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`secret delete failed code=${r.code}`)
    },
  }
}

export function memorySecrets(): SecretStore & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    set: async (n, s) => void items.set(n, s),
    get: async (n) => items.get(n) ?? null,
    delete: async (n) => void items.delete(n),
  }
}
