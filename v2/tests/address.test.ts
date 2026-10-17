import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressHost, cleanAddress, isSecretParam, MAX_ADDRESS_CHARS } from '../capture/address.ts'
import { Privacy } from '../capture/normalize.ts'

test('credentials and fragments never survive', () => {
  assert.equal(cleanAddress('https://ana:hunter2@example.com/a/b?q=1#section-3'), 'https://example.com/a/b?q=1')
  assert.equal(cleanAddress('https://mail.example.com/#inbox/FMfcg'), 'https://mail.example.com/')
})

test('the useful query stays; parameters that carry secrets go', () => {
  assert.equal(cleanAddress('https://www.google.com/search?q=q4+budget&hl=en'), 'https://www.google.com/search?q=q4+budget&hl=en')
  assert.equal(cleanAddress('https://docs.example.com/edit?id=1AbC&usp=sharing'), 'https://docs.example.com/edit?id=1AbC&usp=sharing')
  assert.equal(
    cleanAddress('https://app.example.com/cb?code=4/0AX&state=xyz&access_token=ya29&id_token=e&session_id=9&X-Amz-Signature=ff&apiKey=k&pwd=p'),
    'https://app.example.com/cb?state=xyz',
  )
  assert.equal(cleanAddress('https://x.example.com/reset?resetPasswordToken=abc&lang=en'), 'https://x.example.com/reset?lang=en')
  assert.equal(cleanAddress('https://x.example.com/p?SAMLResponse=PHNhbWw&RelayState=r'), 'https://x.example.com/p?RelayState=r')
  assert.equal(cleanAddress('https://x.example.com/p?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig'), 'https://x.example.com/p')
})

test('secret detection works on words, not substrings', () => {
  for (const name of ['token', 'auth_token', 'refreshToken', 'client-secret', 'sig', 'Signature', 'otp', 'passcode', 'KEY', 'accesstoken', 'authtoken', 'sessionkey', 'oauth_verifier', 'xsrftoken', 'idtoken'])
    assert.ok(isSecretParam(name, 'v'), name)
  for (const name of ['q', 'id', 'passenger', 'keyboard', 'monkey', 'codec', 'country', 'tab', 'page'])
    assert.ok(!isSecretParam(name, 'v'), name)
})

test('pages without a real address have none', () => {
  for (const raw of ['chrome://newtab/', 'about:blank', 'edge://settings', 'data:text/html,<h1>x</h1>', 'blob:https://x.com/1', 'javascript:alert(1)', 'chrome-extension://abc/popup.html', 'moz-extension://x/y', 'view-source:https://x.com', '', 'not a url', null])
    assert.equal(cleanAddress(raw), null, String(raw))
  assert.equal(cleanAddress('file:///Users/ana/Notes/plan.html#top'), 'file:///Users/ana/Notes/plan.html')
})

test('overlong addresses lose the query first, then the path', () => {
  const longQuery = 'https://example.com/a?q=' + 'x'.repeat(MAX_ADDRESS_CHARS)
  assert.equal(cleanAddress(longQuery), 'https://example.com/a')
  const longPath = 'https://example.com/' + 'p'.repeat(MAX_ADDRESS_CHARS)
  assert.equal(cleanAddress(longPath), 'https://example.com/')
})

test('site exclusions match the host and its subdomains only', () => {
  const p = new Privacy([{ match: 'site', value: '1password.com', label: '1Password' }])
  assert.ok(p.siteExcluded(addressHost('https://my.1password.com/vaults')))
  assert.ok(p.siteExcluded(addressHost('https://1PASSWORD.com/')))
  assert.ok(p.siteExcluded(addressHost('https://1password.com./')))
  assert.ok(!p.siteExcluded(addressHost('https://not1password.com/')))
  assert.ok(!p.siteExcluded(addressHost('https://1password.com.evil.example/')))
  assert.ok(!p.siteExcluded(addressHost('file:///tmp/x')))
})

test('a site rule never excludes an app by executable name', () => {
  const p = new Privacy([{ match: 'site', value: 'chrome.exe', label: 'x' }])
  const app = { app_id: 'C:\\x\\chrome.exe', name: 'Chrome', path: 'C:\\x\\chrome.exe', pid: 1, registered_browser: true, identity_state: 'ok' as const, store: null }
  assert.equal(p.classify(app).excluded, false)
})

test('authorization and access-key parameters are dropped, whatever the spelling', () => {
  for (const name of ['authorization', 'Authorization', 'http_authorization', 'accesskey', 'AccessKey', 'access_key', 'accessKeyId', 'awsAccessKeyId', 'privatekey'])
    assert.ok(isSecretParam(name, 'v'), name)
  assert.equal(cleanAddress('https://api.example.com/x?authorization=Bearer+abc.def&q=1'), 'https://api.example.com/x?q=1')
  assert.equal(cleanAddress('https://s3.example.com/b?accesskey=AKIA123&page=2'), 'https://s3.example.com/b?page=2')
  assert.equal(cleanAddress('https://x.example.com/?h=Bearer%20abc123&q=2'), 'https://x.example.com/?q=2', 'a bearer value goes whatever the name')
})

test('an address inside a parameter is kept as written when it carries nothing to remove, and dropped whole when it does', () => {
  assert.equal(cleanAddress('https://login.example.com/?returnUrl=https%3A%2F%2Fapp.example.com%2Fcb%3Fdoc%3D7&q=1'), 'https://login.example.com/?returnUrl=https%3A%2F%2Fapp.example.com%2Fcb%3Fdoc%3D7&q=1')
  for (const v of [
    'https://app.example.com/cb?token=abc&doc=7#frag',
    'https://b.example.com/?redirect=' + encodeURIComponent('https://c.example.com/?code=zz'),
    '/home?session=s1&tab=2#x',
    'https://me:pw@b.example.com/',
    'javascript:alert(1)',
  ])
    assert.equal(cleanAddress('https://a.example.com/?next=' + encodeURIComponent(v) + '&q=1'), 'https://a.example.com/?q=1', v)
})

test('nested addresses are found after normalizing, relative or absolute, and cleaned or dropped', () => {
  const canary = (v: string) => cleanAddress('https://login.example.com/?next=' + encodeURIComponent(v) + '&q=1')!
  for (const v of [
    ' https://u:CANARY_PASSWORD@app.example/cb?access_token=CANARY_TOKEN#CANARY_FRAGMENT',
    '\thttps://app.example/cb?access_token=CANARY_TOKEN#CANARY_FRAGMENT\n',
    'callback?access_token=CANARY_TOKEN#CANARY_FRAGMENT',
    'cb/next?x=1&session=CANARY_TOKEN',
    'mailto:CANARY_PASSWORD@example.com?subject=CANARY_TOKEN',
    '\\\\evil.example?token=CANARY_TOKEN',
  ]) {
    const out = canary(v)
    assert.ok(!/CANARY/.test(decodeURIComponent(decodeURIComponent(out))), `${JSON.stringify(v)} -> ${out}`)
    assert.ok(out.endsWith('q=1'), 'the other parameters stay')
  }
  assert.equal(cleanAddress('https://www.google.com/search?q=how+to+fix+this%3F'), 'https://www.google.com/search?q=how+to+fix+this%3F', 'a question is not an address')
  assert.equal(cleanAddress('https://www.google.com/search?q=site%3Aexample.com+budget'), 'https://www.google.com/search?q=site%3Aexample.com+budget')
})

test('percent-encoded and control-prefixed addresses inside parameters are decoded before judging', () => {
  const secret = 'https://u:CANARY@app.example/cb?access_token=CANARY#CANARY'
  for (const v of [
    encodeURIComponent(secret),
    encodeURIComponent(encodeURIComponent(secret)),
    '\u0000' + secret,
    '\u001f\u0001' + secret,
    '%00' + encodeURIComponent(secret),
    encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent(secret)))),
  ]) {
    const out = cleanAddress('https://login.example.com/?next=' + encodeURIComponent(v) + '&q=1')!
    let d = out
    for (let i = 0; i < 6; i++) d = decodeURIComponent(d)
    assert.ok(!d.includes('CANARY'), `${JSON.stringify(v).slice(0, 60)} -> ${out}`)
    assert.ok(out.endsWith('q=1'))
  }
  assert.equal(cleanAddress('https://shop.example.com/?q=50%25+off'), 'https://shop.example.com/?q=50%25+off', 'a literal percent in text stays')
  assert.equal(cleanAddress('https://www.google.com/search?q=how+to+fix+this%3F'), 'https://www.google.com/search?q=how+to+fix+this%3F')
})


test('a parent-relative destination keeps its path text exactly, or is dropped whole', () => {
  assert.equal(cleanAddress('https://a.example.com/?next=..%2Fcallback%3Fdoc%3D7&q=1'), 'https://a.example.com/?next=..%2Fcallback%3Fdoc%3D7&q=1')
  assert.equal(cleanAddress('https://a.example.com/?next=..%2Fcallback%3Ftoken%3Dsecret%26doc%3D7&q=1'), 'https://a.example.com/?q=1')
  assert.equal(cleanAddress('https://a.example.com/?next=.%2Fa%2F..%2Fb%3Fdoc%3D7'), 'https://a.example.com/?next=.%2Fa%2F..%2Fb%3Fdoc%3D7')
})

test('shared-document access keys go whatever their case or separators, and the document stays', () => {
  assert.equal(cleanAddress('https://onedrive.live.com/redir?resid=ABC123%21456&authkey=%21AbCdEfGh'), 'https://onedrive.live.com/redir?resid=ABC123%21456')
  assert.equal(
    cleanAddress('https://drive.google.com/file/d/1AbCdEf/view?resourcekey=0-xYz123&usp=sharing'),
    'https://drive.google.com/file/d/1AbCdEf/view?usp=sharing',
  )
  for (const name of ['authkey', 'AUTHKEY', 'authKey', 'auth_key', 'auth-key', 'resourcekey', 'resourceKey', 'resource_key', 'RESOURCE-KEY', 'sharekey', 'share_key'])
    assert.ok(isSecretParam(name, 'v'), name)
})

test('a credential hidden by encoding or a control prefix is still a credential', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.c2lnbmF0dXJl'
  for (const raw of [
    'h=Bearer%2520CANARY',
    'h=%00Basic+Q0FOQVJZOnBhc3M%3D',
    'h=' + encodeURIComponent(encodeURIComponent(jwt)),
    'h=%01%1fBearer+CANARY',
    'h=bearer%252520CANARY',
  ]) {
    const out = cleanAddress('https://x.example.com/?' + raw + '&q=1')!
    assert.equal(out, 'https://x.example.com/?q=1', raw)
  }
  assert.equal(cleanAddress('https://x.example.com/?q=bearer+market+2026'), 'https://x.example.com/?q=bearer+market+2026', 'the word alone is not a credential')
})

test('values shaped like credentials go whatever they are called; identities and ordinary values stay', () => {
  const sweep: [string, string][] = [
    ['https://www.dropbox.com/scl/fi/x1y2z3/report.pdf?rlkey=k3x9d0n4q8y2b7m1v5c6z0a2f&dl=0', 'https://www.dropbox.com/scl/fi/x1y2z3/report.pdf?dl=0'],
    [
      'https://calendar.google.com/calendar/event?eid=NWg3ZzhqOWsxMGZkc2FfMjAyNjEwMTZUMDkwMDAwWiBhbmFAZXhhbXBsZS5jb20&tok=MTMjYW5hQGV4YW1wbGUuY29tNGE1YjZjN2Q4ZTlmMGExYjJjM2Q0ZTVm&ctz=Africa%2FKigali',
      'https://calendar.google.com/calendar/event?eid=NWg3ZzhqOWsxMGZkc2FfMjAyNjEwMTZUMDkwMDAwWiBhbmFAZXhhbXBsZS5jb20&ctz=Africa%2FKigali',
    ],
    ['https://onedrive.live.com/redir?resid=ABC123%21456&cid=0f1e2d3c4b5a6978', 'https://onedrive.live.com/redir?resid=ABC123%21456&cid=0f1e2d3c4b5a6978'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing'],
    ['https://www.figma.com/design/AbC123dEf456GhI789jKl/Plan?node-id=12-345&m=dev', 'https://www.figma.com/design/AbC123dEf456GhI789jKl/Plan?node-id=12-345&m=dev'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'],
    ['https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef?pvs=4', 'https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef?pvs=4'],
    ['https://www.notion.so/acme?p=0123456789abcdef0123456789abcdef&pm=s', 'https://www.notion.so/acme?p=0123456789abcdef0123456789abcdef&pm=s'],
    ['https://shop.example.com/s?k=iPhone15ProMaxCase2026&ref=nb_sb_noss', 'https://shop.example.com/s?k=iPhone15ProMaxCase2026&ref=nb_sb_noss'],
    ['https://www.google.com/search?q=quarterly+report+2026', 'https://www.google.com/search?q=quarterly+report+2026'],
    ['https://x.example.com/share?x=q8Z2kP0vLm3NcT7aB1sD4fGh&page=2', 'https://x.example.com/share?page=2'],
    ['https://x.example.com/dl?h=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'https://x.example.com/dl'],
  ]
  for (const [raw, want] of sweep) assert.equal(cleanAddress(raw), want, raw)
})

test('a JSON web token is known by its structure, not by how its header happens to be written', () => {
  const tokens = [
    'eyJhbGciOiJub25lIn0.e30.',
    'IHsiYWxnIjoiSFMyNTYiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlc2lnbmF0dXJl',
    'CnsiYWxnIjoiUlMyNTYifQ.e30.',
  ]
  for (const t of tokens) {
    assert.equal(cleanAddress(`https://app.example.com/cb?state=${t}&page=2`), 'https://app.example.com/cb?page=2', t)
    assert.equal(cleanAddress(`https://app.example.com/cb?id=${t}`), 'https://app.example.com/cb', t)
  }
  for (const kept of ['1.2.3', 'www.example.com', 'e30.e30.e30', 'eyJmb28iOiJiYXIifQ.e30.']) assert.equal(cleanAddress(`https://app.example.com/?q=${kept}`), `https://app.example.com/?q=${kept}`, kept)
})

test('Basic is a credential only when its token is base64 of text with a colon; Bearer keeps its single-token rule', () => {
  const page = (q: string) => `https://www.google.com/search?q=${q}&hl=en`
  for (const kept of ['basic+income', 'Basic+Instinct', 'basic+math', 'basic+dXNlcnBhc3M']) assert.equal(cleanAddress(page(kept)), page(kept), kept)
  for (const dropped of ['Basic+dXNlcjpwYXNz', 'basic%20YW5hOmh1bnRlcjI%3D', 'Bearer+abc.def', 'bearer%20income'])
    assert.equal(cleanAddress(page(dropped)), 'https://www.google.com/search?hl=en', dropped)
})
