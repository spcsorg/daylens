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
const SECRET_PARTS = [
  'token', 'secret', 'password', 'passwd', 'signature', 'apikey', 'accesskey', 'privatekey', 'sessionid', 'sessionkey', 'authcode',
  'authoriz', 'verifier', 'credential',
]

// An HTTP credential pasted into a parameter, whatever the parameter is called.
const CREDENTIAL_VALUE = /^(bearer|basic)\s/i
// Parameter values that are addresses in their own right (returnUrl, next, redirect) get the same rule; addresses
// that can run code or carry content are dropped. A plain "site:example.com" is not an address and stays.
const NESTED_ADDRESS = /^(https?:|file:|\/\/)/i
const DROPPED_ADDRESS = /^(javascript|data|vbscript|blob):/i
const MAX_NESTING = 4
const RELATIVE_BASE = 'https://relative.invalid'

const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function isSecretParam(name: string, value: string): boolean {
  return nameWords(name).some((w) => SECRET_WORDS.has(w) || SECRET_PARTS.some((p) => w.includes(p))) || JWT_VALUE.test(value) || CREDENTIAL_VALUE.test(value)
}

// Returns null when the page has no address worth keeping (new tab, settings, data: and the like).
export function cleanAddress(raw: string | null | undefined): string | null {
  return clean(raw, 0)
}

// A parameter value after the rule: unchanged, cleaned as an address, or null to drop the parameter.
// Values are judged the way a URL parser reads them (tabs and newlines removed, ends trimmed); when unsure, drop.
function cleanValue(value: string, depth: number): string | null {
  const t = value.replace(/[\t\n\r]/g, '').trim()
  if (DROPPED_ADDRESS.test(t)) return null
  if (NESTED_ADDRESS.test(t)) {
    if (depth >= MAX_NESTING) return null
    return clean(t.startsWith('//') ? 'https:' + t : t, depth + 1)
  }
  const looksAddressed = /[?#]/.test(t)
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return looksAddressed || t.includes('@') ? null : value
  if (!looksAddressed && !t.includes('\\')) return value
  if (depth >= MAX_NESTING) return null
  // A relative address: read against a placeholder base; one that escapes the base (\\host, //host) is dropped.
  let u: URL
  try {
    u = new URL(t, RELATIVE_BASE + '/')
  } catch {
    return null
  }
  if (u.origin !== RELATIVE_BASE) return null
  const cleaned = clean(u.href, depth + 1)
  if (cleaned === null) return null
  // Nothing removed: keep the text as written (a search such as "how to fix this?" is not an address).
  if (cleaned === u.href) return value
  return t.startsWith('/') ? cleaned.slice(RELATIVE_BASE.length) : cleaned.slice(RELATIVE_BASE.length + 1)
}

function clean(raw: string | null | undefined, depth: number): string | null {
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
    for (const [k, v] of u.searchParams) {
      if (isSecretParam(k, v)) continue
      const c = cleanValue(v, depth)
      if (c !== null) kept.append(k, c)
    }
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
