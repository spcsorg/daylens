// One self-signed code-signing identity for builds made on this Mac. macOS ties the helper's Accessibility grant to its
// signature; an ad-hoc signature changes with every build, a certificate does not, so the grant holds from build to
// build. The identity lives in its own keychain with a random password kept beside it, so a build at night signs with
// no prompt. It is replaced by Developer ID.
// Usage: node app/package/localSigning.ts   (makes the identity if there is none, then prints it)
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const NIGHTLY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Daylens Nightly')
const KEYCHAIN = path.join(NIGHTLY_DIR, 'signing.keychain-db')
const PASSWORD = path.join(NIGHTLY_DIR, 'signing.password')
const NAME = 'Daylens Local Signing'

const security = (args: string[]) => execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export interface LocalIdentity {
  hash: string
  keychain: string
}

export function localIdentity(): LocalIdentity {
  if (!existsSync(KEYCHAIN)) throw new Error(`no local signing identity; make it with: node app/package/localSigning.ts`)
  security(['unlock-keychain', '-p', readFileSync(PASSWORD, 'utf8'), KEYCHAIN])
  const hash = /SHA-1 hash: ([0-9A-F]{40})/.exec(security(['find-certificate', '-c', NAME, '-Z', KEYCHAIN]))?.[1]
  if (!hash) throw new Error(`${KEYCHAIN} holds no "${NAME}" certificate`)
  return { hash, keychain: KEYCHAIN }
}

function create(): void {
  mkdirSync(NIGHTLY_DIR, { recursive: true, mode: 0o700 })
  const password = randomBytes(24).toString('base64url')
  writeFileSync(PASSWORD, password, { mode: 0o600 })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'daylens-signing-'))
  try {
    writeFileSync(
      path.join(tmp, 'cert.cnf'),
      `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${NAME}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`,
    )
    const ssl = (args: string[]) => execFileSync('/usr/bin/openssl', args, { cwd: tmp, stdio: 'ignore' })
    ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-config', 'cert.cnf', '-keyout', 'key.pem', '-out', 'cert.pem'])
    ssl(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-name', NAME, '-out', 'id.p12', '-passout', `pass:${password}`])
    security(['create-keychain', '-p', password, KEYCHAIN])
    // No lock timeout and no lock on sleep: the build at night finds it open.
    security(['set-keychain-settings', KEYCHAIN])
    security(['import', path.join(tmp, 'id.p12'), '-k', KEYCHAIN, '-P', password, '-T', '/usr/bin/codesign'])
    // Lets codesign use the key without asking.
    security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, KEYCHAIN])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (!existsSync(KEYCHAIN)) create()
  const id = localIdentity()
  process.stdout.write(`${NAME} ${id.hash}\n${id.keychain}\n`)
}
