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
