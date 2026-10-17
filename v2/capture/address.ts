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

// A parameter value after the rule: kept exactly as written, or null to drop it. A value is never rewritten.
// It is read the way a URL parser would (C0 controls removed) and percent-decoded up to three times; if any form of
// it looks like an address and the rule would remove anything from that address, or the decoding is ambiguous, the
// whole value is dropped. Plain text such as "how to fix this?" stays.
const MAX_DECODES = 3
const CONTROLS = /[\u0000-\u001f\u007f]/g
const ENCODED_SYNTAX = /%(3a|2f|3f|23|40|25|5c)/i

function looksLikeAddress(f: string): boolean {
  return f.includes('://') || /^(\/\/|\\)/.test(f) || /[?#]/.test(f) || (f.includes('@') && f.includes(':'))
}

function cleanValue(value: string, depth: number): string | null {
  let f = value.replace(CONTROLS, '').trim()
  const forms = [f]
  for (let i = 0; i < MAX_DECODES && /%[0-9a-f]{2}/i.test(f); i++) {
    let d: string
    try {
      d = decodeURIComponent(f)
    } catch {
      if (forms.some(looksLikeAddress)) return null
      break
    }
    d = d.replace(CONTROLS, '').trim()
    if (d === f) break
    forms.push((f = d))
  }
  // Still carrying encoded URL syntax after the last decode: what it hides cannot be judged.
  if (forms.length > MAX_DECODES && ENCODED_SYNTAX.test(f)) return null
  for (const form of forms) if (DROPPED_ADDRESS.test(form) || (looksLikeAddress(form) && wouldRemove(form, depth))) return null
  return value
}

// Whether the rule would take anything out of this address, or cannot read it as one it keeps.
function wouldRemove(form: string, depth: number): boolean {
  if (depth >= MAX_NESTING || DROPPED_ADDRESS.test(form)) return true
  let u: URL
  try {
    if (/^[\\/]{2}/.test(form)) u = new URL('https://' + form.replace(/^[\\/]+/, ''))
    else if (/^[a-z][a-z0-9+.-]*:/i.test(form)) {
      if (!/^(https?|file):/i.test(form)) return true
      u = new URL(form)
    } else {
      u = new URL(form, RELATIVE_BASE + '/')
      if (u.origin !== RELATIVE_BASE) return true
    }
  } catch {
    return true
  }
  if (u.username || u.password || u.hash) return true
  for (const [k, v] of u.searchParams) if (isSecretParam(k, v) || cleanValue(v, depth + 1) === null) return true
  return false
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
