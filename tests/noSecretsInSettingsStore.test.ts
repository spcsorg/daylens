// Secrets must never reach the settings store on disk.
//
// A real Anthropic key (sk-ant-api03-…, 108 chars) was found in plaintext at
// ~/Library/Application Support/Daylens/config.json — the electron-store file
// of the legacy GRDB-era app, which persisted `anthropicApiKey` as an ordinary
// setting. The current app keeps provider keys in the OS secure store, and this
// test is what stops the old shape from coming back: provider keys must go
// through keytar, and no settings key may look like a credential.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, setApiKey } from '../src/main/services/settings.ts'

// Substrings that mark a value as credential-bearing rather than a preference.
// `aiProvider`, `mcpServers` and friends are configuration; `apiKey` is not.
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|password|passphrase|bearer|credential|(^|[^a-z])token([^a-z]|$)|private[-_]?key)/i

// The shape of a real provider key, so a value cannot slip in under an
// innocent-looking name.
const SECRET_VALUE_PATTERNS = [
  /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /sk-or-v1-[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
]

function walk(value: unknown, path: string, onLeaf: (path: string, leaf: string) => void): void {
  if (typeof value === 'string') {
    onLeaf(path, value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, onLeaf))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, onLeaf)
    }
  }
}

function keyNames(value: unknown, path: string, out: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key
    out.push(next)
    keyNames(child, next, out)
  }
}

test('no settings key is named like a credential', () => {
  const names: string[] = []
  keyNames(DEFAULTS, '', names)
  const offenders = names.filter((name) => SECRET_KEY_PATTERN.test(name.split('.').at(-1) ?? name))
  assert.deepEqual(
    offenders,
    [],
    `settings keys must not carry credentials — provider keys belong in the secure store. Offenders: ${offenders.join(', ')}`,
  )
})

test('no settings default holds a secret-shaped value', () => {
  const offenders: string[] = []
  walk(DEFAULTS, '', (path, leaf) => {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(leaf))) offenders.push(path)
  })
  assert.deepEqual(offenders, [], `secret-shaped values in settings defaults: ${offenders.join(', ')}`)
})

test('the legacy anthropicApiKey setting is gone and stays gone', () => {
  assert.ok(
    !('anthropicApiKey' in (DEFAULTS as Record<string, unknown>)),
    'anthropicApiKey was the leaked field — it must never be a setting again',
  )
})

test('setApiKey never falls back to the settings store', async () => {
  // With no keytar in the hermetic environment, saving a key must FAIL loudly
  // rather than degrade to persisting the value as an ordinary setting.
  const before = JSON.stringify(DEFAULTS)
  await assert.rejects(
    () => setApiKey('anthropic', 'sk-ant-api03-regression-probe-value-0000000000'),
    'saving a key without a secure store must throw, not persist',
  )
  assert.equal(JSON.stringify(DEFAULTS), before, 'settings must be untouched by a failed key write')
})

test('CLI providers need no stored key at all', async () => {
  // The reason a dead API key is not a blocker: claude-cli / codex-cli and
  // friends authenticate through their own CLI, so setApiKey is a no-op and
  // nothing is ever written anywhere.
  for (const provider of ['claude-cli', 'codex-cli', 'gemini-cli', 'chatgpt-cli'] as const) {
    await setApiKey(provider, 'must-be-ignored')
  }
})
