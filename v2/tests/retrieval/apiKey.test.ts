import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { keyStore, KeyStoreError, type SecretCipher } from '../../retrieval/apiKey.ts'
import { tmpDir } from '../storage/support.ts'

const cipher = (over: Partial<SecretCipher> = {}): SecretCipher => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  getSelectedStorageBackend: () => 'gnome_libsecret',
  ...over,
})

test('the key is saved only encrypted, readable only by the person, and can be removed', () => {
  const file = path.join(tmpDir(), 'api-key')
  const store = keyStore(file, cipher(), 'linux')
  assert.equal(store.load(), null)
  store.save('  sk-ant-test-123  \n')
  assert.ok(!readFileSync(file).toString('latin1').includes('sk-ant'), 'never written in the clear')
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(store.load(), 'sk-ant-test-123')
  store.clear()
  assert.equal(store.load(), null)
})

test('with no secure storage, or a Linux keyring fallback that protects nothing, the key is not saved and the reason is given', () => {
  const dir = tmpDir()
  assert.throws(() => keyStore(path.join(dir, 'a'), cipher({ isEncryptionAvailable: () => false })).save('k'), KeyStoreError)
  assert.throws(() => keyStore(path.join(dir, 'b'), cipher({ getSelectedStorageBackend: () => 'basic_text' }), 'linux').save('k'), /No keyring/)
  keyStore(path.join(dir, 'c'), cipher({ getSelectedStorageBackend: () => 'basic_text' }), 'darwin').save('k')
  assert.throws(() => keyStore(path.join(dir, 'd'), cipher()).save('   '), /empty/)
})

test('a saved key this computer cannot decrypt asks for the key again', () => {
  const file = path.join(tmpDir(), 'api-key')
  keyStore(file, cipher()).save('k')
  assert.throws(() => keyStore(file, cipher({ decryptString: () => { throw new Error('bad') } })).load(), /Enter it again/)
})
