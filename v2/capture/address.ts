// The one rule for page addresses, used by the browser extension and the history readers alike.
// Keeps the page address and a short list of search and page-identity parameters; everything else is removed.
// Secrets written into the path itself stay. Runs in Node and in the extension, so it depends only on the URL standard.

export const MAX_ADDRESS_CHARS = 2048

const KEPT_SCHEMES = new Set(['http:', 'https:', 'file:'])

// Names are compared lowercased with separators removed, so node-id, nodeId and NODE_ID are the same name.
// Searches hold typed text and identities are random by design, so neither gets the key-shape rule; the one-letter
// aliases s and k also name signatures and login payloads on some sites, so they get it.
const SEARCH_NAMES = new Set(['q', 'query', 'search', 'searchquery', 'term', 'nkw'])
const ALIAS_NAMES = new Set(['s', 'k'])
const IDENTITY_NAMES = new Set(['id', 'ids', 'v', 'list', 'resid', 'cid', 'eid', 'file', 'doc', 'item', 'video', 'post', 'node', 'nodeid', 'sha', 'commit', 'rev', 'sourcedoc', 'th'])
// Short generic names carry credentials on some sites, so they keep only the one shape they mean.
const NUMBER_NAMES = new Set(['p', 'page'])
const TIME_NAMES = new Set(['t'])
const VIEW_NAMES = new Set(['hl', 'lang', 'm', 'tab', 'view', 'usp', 'dl', 'sort', 'filter', 'category', 'cat'])

const NUMBER_VALUE = /^\d+$/
const TIME_VALUE = /^(\d+|(?=\d)(\d+h)?(\d+m)?(\d+s)?)$/
const UUID_VALUE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i
const LONG_HEX = /^[0-9a-f]{32,}$/i

// Click and campaign tracking IDs name the visit, not the page.
const TRACKING_NAME = /^(utm|mc|hs)|clk?id$|^(igshid|lifatid|srsltid|mkteid|gbraid|wbraid)$/

// Vetoes a listed name, whatever the list holds.
const SECRET_WORDS = new Set([
  'token', 'tokens', 'code', 'codes', 'key', 'keys', 'apikey', 'session', 'sessions', 'sessionid', 'sid', 'jsessionid', 'phpsessid',
  'password', 'passwd', 'pwd', 'pass', 'passcode', 'secret', 'signature', 'sig', 'signed', 'hmac', 'jwt', 'otp', 'auth', 'credential',
  'credentials', 'ticket', 'samlresponse', 'samlrequest', 'assertion',
])
const SECRET_PARTS = [
  'token', 'secret', 'password', 'passwd', 'signature', 'apikey', 'accesskey', 'privatekey', 'sessionid', 'sessionkey', 'authcode',
  'authoriz', 'verifier', 'credential', 'authkey', 'resourcekey', 'sharekey', 'signingkey', 'secretkey', 'encryptionkey',
]

type Kind = 'search' | 'alias' | 'identity' | 'number' | 'time' | 'view'

function joinedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSecretName(name: string): boolean {
  const joined = joinedName(name)
  return nameWords(name).some((w) => SECRET_WORDS.has(w)) || SECRET_PARTS.some((p) => joined.includes(p))
}

// The kind of a kept parameter, or null for one that is removed.
export function keptParam(name: string): Kind | null {
  const joined = joinedName(name)
  if (isSecretName(name) || TRACKING_NAME.test(joined)) return null
  if (SEARCH_NAMES.has(joined)) return 'search'
  if (ALIAS_NAMES.has(joined)) return 'alias'
  if (IDENTITY_NAMES.has(joined)) return 'identity'
  if (NUMBER_NAMES.has(joined)) return 'number'
  if (TIME_NAMES.has(joined)) return 'time'
  if (VIEW_NAMES.has(joined)) return 'view'
  return null
}

function base64Bytes(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

// Basic counts when its token is base64 of anything with a colon byte: user:password in UTF-8, Latin-1 or UTF-16.
const BEARER_VALUE = /^bearer\s+[A-Za-z0-9\-._~+/]+=*$/i
const BASIC_VALUE = /^basic\s+([A-Za-z0-9+/]+={0,2})$/i

function isCredential(value: string): boolean {
  if (BEARER_VALUE.test(value)) return true
  const token = BASIC_VALUE.exec(value)?.[1]
  return token !== undefined && (base64Bytes(token)?.includes(0x3a) ?? false)
}

// A JWT (three parts, empty signature allowed) or JWE (five, empty key part for direct encryption) whose header is a
// JSON object with an alg.
const B64URL_PART = /^[A-Za-z0-9_-]*=*$/

function isJwt(value: string): boolean {
  const parts = value.trim().split('.')
  if ((parts.length !== 3 && parts.length !== 5) || !parts.every((p) => B64URL_PART.test(p))) return false
  const required = parts.length === 3 ? [0, 1] : [0, 2, 3]
  if (required.some((i) => !parts[i])) return false
  const bytes = base64Bytes((parts[0] ?? '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'))
  if (bytes === null) return false
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return !!header && typeof header === 'object' && !Array.isArray(header) && 'alg' in header
  } catch {
    return false
  }
}

function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

// 32+ hex mixing digits and letters, or 20+ characters of one base64 alphabet with few separators, two character
// classes, 3.5+ bits each, and a digit or four capitals after the first letter (a capitalized compound word has neither).
function looksGenerated(value: string): boolean {
  const s = value.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/_-]+$/.test(s)) return false
  if (/^[0-9a-f]+$/i.test(s)) return s.length >= 32 && /[0-9]/.test(s) && /[a-f]/i.test(s)
  if (s.length < 20 || (s.match(/[+/_-]/g)?.length ?? 0) > s.length * 0.1) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length
  const capitals = s.slice(1).match(/[A-Z]/g)?.length ?? 0
  return classes >= 2 && entropy(s) >= 3.5 && (/[0-9]/.test(s) || capitals >= 4)
}

function fitsKind(form: string, kind: Kind): boolean {
  if (kind === 'number') return NUMBER_VALUE.test(form)
  if (kind === 'time') return TIME_VALUE.test(form)
  if (kind === 'view') return !UUID_VALUE.test(form) && !LONG_HEX.test(form) && !looksGenerated(form)
  if (kind === 'alias') return !isJsonContainer(form) && !LONG_HEX.test(form) && !looksGenerated(form)
  if (kind === 'search') return !isJsonContainer(form)
  return true
}

function isJsonContainer(form: string): boolean {
  if (!/^[[{]/.test(form)) return false
  try {
    const v: unknown = JSON.parse(form)
    return typeof v === 'object' && v !== null
  } catch {
    return false
  }
}

// Returns null when the page has no address worth keeping (new tab, settings, data: and the like).
export function cleanAddress(raw: string | null | undefined): string | null {
  return clean(raw, 0)
}

// A plain "site:example.com" is not an address and stays.
const DROPPED_ADDRESS = /^(javascript|data|vbscript|blob):/i
const MAX_NESTING = 4
const RELATIVE_BASE = 'https://relative.invalid'
const MAX_DECODES = 3
const CONTROLS = /[\u0000-\u001f\u007f]/g
const ENCODED_SYNTAX = /%(3a|2f|3f|23|40|25|5c)/i

function looksLikeAddress(f: string): boolean {
  return f.includes('://') || /^(\/\/|\\)/.test(f) || /[?#]/.test(f) || (f.includes('@') && f.includes(':'))
}

// A search is text unless it starts the way an address does: a scheme and //, // or \, or an absolute URL with a
// host (https:example.com). "why? because", "F# tutorial" and "site:example.com" are text.
function startsLikeAddress(f: string): boolean {
  if (/^([a-z][a-z0-9+.-]*:)?(\/\/|\\)/i.test(f)) return true
  try {
    return new URL(f).host !== ''
  } catch {
    return false
  }
}

// A kept value is never rewritten: it stays as written, or null drops it. Every control-stripped, percent-decoded form
// is judged, and any credential, token, generated-looking view value, or address the rule would change drops it.
function cleanValue(value: string, depth: number, kind: Kind): string | null {
  const text = kind === 'search' || kind === 'alias'
  const isAddress = text ? startsLikeAddress : looksLikeAddress
  let f = value.replace(CONTROLS, '').trim()
  const forms = [f]
  for (let i = 0; i < MAX_DECODES && /%[0-9a-f]{2}/i.test(f); i++) {
    let d: string
    try {
      d = decodeURIComponent(f)
    } catch {
      if (forms.some(isAddress)) return null
      break
    }
    d = d.replace(CONTROLS, '').trim()
    if (d === f) break
    forms.push((f = d))
  }
  // Still carrying encoded URL syntax after the last decode: what it hides cannot be judged.
  if (forms.length > MAX_DECODES && ENCODED_SYNTAX.test(f)) return null
  for (const form of forms) {
    if (isCredential(form) || isJwt(form) || !fitsKind(form, kind)) return null
    if (text ? isAddress(form) && wouldRemove(form, depth) : DROPPED_ADDRESS.test(form) || (isAddress(form) && wouldRemove(form, depth))) return null
  }
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
  for (const [k, v] of u.searchParams) {
    const kind = keptParam(k)
    if (kind === null || cleanValue(v, depth + 1, kind) === null) return true
  }
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
      const kind = keptParam(k)
      if (kind === null) continue
      const c = cleanValue(v, depth, kind)
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
