// The person's own API key, kept encrypted by the platform's secure storage (Electron's safeStorage: a key held in the
// Keychain on macOS, DPAPI on Windows, the Secret Service or KWallet on Linux). Only the main process reads it; the
// interface is told whether a key is saved, never the key.
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** The part of Electron's safeStorage used here. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  // Linux only: which store holds the encryption key.
  getSelectedStorageBackend?(): string
}

export class KeyStoreError extends Error {}

export interface KeyStore {
  save(key: string): void
  // null when no key is saved.
  load(): string | null
  clear(): void
}

export function keyStore(file: string, cipher: SecretCipher, platform: NodeJS.Platform = process.platform): KeyStore {
  const usable = () => {
    if (!cipher.isEncryptionAvailable()) throw new KeyStoreError('This computer’s secure storage is not available, so the key can’t be saved.')
    // Without a keyring Electron falls back to a fixed password, which protects nothing.
    if (platform === 'linux' && cipher.getSelectedStorageBackend?.() === 'basic_text') throw new KeyStoreError('No keyring (such as GNOME Keyring or KWallet) is running, so the key can’t be saved securely.')
  }
  return {
    save(key) {
      const k = key.trim()
      if (!k) throw new KeyStoreError('The key is empty.')
      usable()
      const tmp = `${file}.tmp`
      writeFileSync(tmp, cipher.encryptString(k), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
    },
    load() {
      if (!existsSync(file)) return null
      usable()
      try {
        return cipher.decryptString(readFileSync(file))
      } catch {
        throw new KeyStoreError('The saved key can’t be read on this computer. Enter it again.')
      }
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}
