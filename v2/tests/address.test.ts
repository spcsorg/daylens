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

test('URL-valued parameters are cleaned by the same rule, nested or relative', () => {
  assert.equal(
    cleanAddress('https://login.example.com/?returnUrl=https%3A%2F%2Fapp.example.com%2Fcb%3Ftoken%3Dabc%26doc%3D7%23frag&q=1'),
    'https://login.example.com/?returnUrl=https%3A%2F%2Fapp.example.com%2Fcb%3Fdoc%3D7&q=1',
  )
  assert.equal(
    cleanAddress('https://a.example.com/?next=https%3A%2F%2Fb.example.com%2F%3Fredirect%3Dhttps%253A%252F%252Fc.example.com%252F%253Fcode%253Dzz'),
    'https://a.example.com/?next=https%3A%2F%2Fb.example.com%2F%3Fredirect%3Dhttps%253A%252F%252Fc.example.com%252F',
  )
  assert.equal(cleanAddress('https://a.example.com/?next=%2Fhome%3Fsession%3Ds1%26tab%3D2%23x'), 'https://a.example.com/?next=%2Fhome%3Ftab%3D2')
  assert.equal(cleanAddress('https://a.example.com/?u=https%3A%2F%2Fme%3Apw%40b.example.com%2F'), 'https://a.example.com/?u=https%3A%2F%2Fb.example.com%2F')
  assert.equal(cleanAddress('https://a.example.com/?u=javascript%3Aalert(1)&q=1'), 'https://a.example.com/?q=1', 'a URL value with a scheme the rule does not keep is dropped')
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
