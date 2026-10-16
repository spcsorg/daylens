// The one rule for page addresses, used by the browser extension and the history readers alike.
// Keeps the query (searches, document IDs) but never credentials, fragments, or parameters that carry secrets.
// Runs in Node and in the extension, so it depends only on the URL standard.

export const MAX_ADDRESS_CHARS = 2048

const KEPT_SCHEMES = new Set(['http:', 'https:', 'file:'])

// A parameter is dropped when any word of its name is one of these.
const SECRET_WORDS = new Set([
  'token', 'tokens', 'code', 'codes', 'key', 'keys', 'apikey', 'session', 'sessions', 'sessionid', 'sid', 'jsessionid', 'phpsessid',
  'password', 'passwd', 'pwd', 'pass', 'passcode', 'secret', 'signature', 'sig', 'signed', 'hmac', 'jwt', 'otp', 'auth', 'credential',
  'credentials', 'ticket', 'samlresponse', 'samlrequest', 'assertion',
])

// Names written as one lowercase word (accesstoken, sessionkey) still carry these; short words like key or code are
// matched as whole words only, so keyboard and codec stay.
const SECRET_PARTS = ['token', 'secret', 'password', 'passwd', 'signature', 'apikey', 'sessionid', 'sessionkey', 'authcode', 'verifier', 'credential']

const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function isSecretParam(name: string, value: string): boolean {
  return nameWords(name).some((w) => SECRET_WORDS.has(w) || SECRET_PARTS.some((p) => w.includes(p))) || JWT_VALUE.test(value)
}

// Returns null when the page has no address worth keeping (new tab, settings, data: and the like).
export function cleanAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!KEPT_SCHEMES.has(u.protocol)) return null
  u.username = ''
  u.password = ''
  u.hash = ''
  if (u.search) {
    const kept = new URLSearchParams()
    for (const [k, v] of u.searchParams) if (!isSecretParam(k, v)) kept.append(k, v)
    u.search = kept.toString()
  }
  let out = u.href
  if (out.length > MAX_ADDRESS_CHARS) {
    u.search = ''
    out = u.href
  }
  if (out.length > MAX_ADDRESS_CHARS) out = u.protocol === 'file:' ? 'file:///' : u.origin + '/'
  return out
}

export function addressHost(address: string): string | null {
  try {
    const h = new URL(address).hostname.toLowerCase()
    return h === '' ? null : h.replace(/\.$/, '')
  } catch {
    return null
  }
}
