// Pairing and the mutual proof for the extension's local connection, shared by the capture service and the extension.
// The secret travels once, from the extension to Daylens, inside a daylens:// link the operating system hands to the
// app; it never crosses the socket. On every connection each side proves it holds the secret with an HMAC over both
// sides' fresh nonces, the extension's origin and the port, so a listener that does not hold it learns nothing and a
// proof made for one port is useless on another.

export const LOCAL_PORTS = [27481, 37471, 46417] as const
export const LOCAL_PATH = '/daylens/browser'
export const PAIR_VERSION = 1

// Extensions allowed to pair, by the origin the browser sends. Store IDs join when each store assigns them.
export const CHROMIUM_EXTENSION_IDS: readonly string[] = [
  'dgidcofcmgnlicmmepgomalcdcbgjjjg', // unpacked dev build (manifest.chromium-dev.json key)
]

const CHROMIUM_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/
const FIREFOX_ORIGIN_RE = /^moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const KEY_RE = /^[A-Za-z0-9_-]{43}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/

// The ID the extension is known by: the Chromium extension ID, or Firefox's per-install UUID. null if not allowed.
export function extensionOfOrigin(origin: string): string | null {
  const c = CHROMIUM_ORIGIN_RE.exec(origin)
  if (c) return CHROMIUM_EXTENSION_IDS.includes(c[1]!) ? c[1]! : null
  const f = FIREFOX_ORIGIN_RE.exec(origin)
  return f ? f[1]! : null
}

export function isNonce(s: unknown): s is string {
  return typeof s === 'string' && NONCE_RE.test(s)
}

export function isPairId(s: unknown): s is string {
  return typeof s === 'string' && ID_RE.test(s)
}

export function toB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomB64url(bytes: number): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export interface Pairing {
  id: string
  key: string
  origin: string
}

export function newPairing(origin: string): Pairing {
  return { id: randomB64url(16), key: randomB64url(32), origin }
}

export function pairLink(p: Pairing): string {
  return `daylens://pair?v=${PAIR_VERSION}&id=${p.id}&key=${p.key}&origin=${encodeURIComponent(p.origin)}`
}

// A daylens://pair link as the operating system delivered it. Anything else is null.
export function parsePairLink(link: string): Pairing | null {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  if (u.protocol !== 'daylens:' || (u.hostname || u.pathname.replace(/^\/+/, '')) !== 'pair') return null
  const q = u.searchParams
  const id = q.get('id')
  const key = q.get('key')
  const origin = q.get('origin')
  if (q.get('v') !== String(PAIR_VERSION) || !isPairId(id) || key === null || !KEY_RE.test(key) || origin === null) return null
  if (extensionOfOrigin(origin) === null) return null
  return { id, key, origin }
}

export type Role = 'service' | 'extension'

export function transcript(role: Role, origin: string, port: number, pairId: string, extNonce: string, svcNonce: string): string {
  return ['daylens-browser-pair-v1', role, origin, `127.0.0.1:${port}`, pairId, extNonce, svcNonce].join('\n')
}

export async function proof(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', fromB64url(key) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toB64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text) as BufferSource)))
}

export function sameProof(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
