import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressHost, cleanAddress, keptParam, MAX_ADDRESS_CHARS } from '../capture/address.ts'
import { Privacy } from '../capture/normalize.ts'

const same = (raw: string) => assert.equal(cleanAddress(raw), raw, raw)

test('credentials and fragments never survive', () => {
  assert.equal(cleanAddress('https://ana:hunter2@example.com/a/b?q=1#section-3'), 'https://example.com/a/b?q=1')
  assert.equal(cleanAddress('https://mail.example.com/#inbox/FMfcg'), 'https://mail.example.com/')
})

test('only search and page-identity parameters stay; every other parameter goes', () => {
  same('https://www.google.com/search?q=q4+budget&hl=en')
  same('https://docs.example.com/edit?id=1AbC&usp=sharing')
  assert.equal(
    cleanAddress('https://app.example.com/cb?code=4/0AX&state=xyz&access_token=ya29&id_token=e&session_id=9&X-Amz-Signature=ff&apiKey=k&pwd=p&lang=en'),
    'https://app.example.com/cb?lang=en',
  )
  assert.equal(cleanAddress('https://x.example.com/p?SAMLResponse=PHNhbWw&RelayState=r&page=3'), 'https://x.example.com/p?page=3')
  assert.equal(cleanAddress('https://shop.example.com/item?utm_source=news&fbclid=IwAR0&gclid=Cj0&ref=nb&sort=price&item=42'), 'https://shop.example.com/item?sort=price&item=42')
  for (const name of ['q', 'Query', 'search', 's', 'k', 'search_query', 'term', '_nkw', 'hl', 'lang', 'v', 'list', 't', 'page', 'p', 'id', 'ids', 'node-id', 'sourcedoc', 'th', 'resid', 'cid', 'eid', 'file', 'doc', 'item', 'video', 'post', 'node', 'm', 'sha', 'commit', 'rev', 'tab', 'view', 'usp', 'dl', 'sort', 'filter', 'category', 'cat'])
    assert.notEqual(keptParam(name), null, name)
  for (const name of ['state', 'next', 'returnUrl', 'redirect', 'h', 'x', 'rlkey', 'tok', 'authkey', 'resourcekey', 'utm_source', 'utm_id', 'ref', 'oobCode', 'mode', 'sv', 'se', 'sp', 'fbclid', 'gclid', 'msclkid', 'ttclid', 'mc_cid', 'mc_eid', 'igshid', 'srsltid', '_hsenc'])
    assert.equal(keptParam(name), null, name)
})

test('a listed shape with a secret word in it still goes: sid and sessionid end in id', () => {
  for (const name of ['sid', 'SID', 'sessionid', 'session_id', 'jsessionid', 'PHPSESSID', 'accessKeyId', 'awsAccessKeyId', 'tokenId', 'authTokenId', 'secretId', 'apikeyid'])
    assert.equal(keptParam(name), null, name)
})

test('every address from the earlier review rounds keeps only what the rule allows', () => {
  const cases: [string, string][] = [
    ['https://api.example.com/x?authorization=Bearer+abc.def&q=1', 'https://api.example.com/x?q=1'],
    ['https://s3.example.com/b?accesskey=AKIA123&page=2', 'https://s3.example.com/b?page=2'],
    ['https://login.example.com/?returnUrl=https%3A%2F%2Fapp.example.com%2Fcb%3Faccess_token%3Dabc%23frag&q=1', 'https://login.example.com/?q=1'],
    ['https://login.example.com/?next=%20https%3A%2F%2Fu%3ACANARY_PASSWORD%40app.example%2Fcb%3Faccess_token%3DCANARY_TOKEN%23CANARY_FRAGMENT&q=1', 'https://login.example.com/?q=1'],
    ['https://login.example.com/?next=callback%3Faccess_token%3DCANARY_TOKEN%23CANARY_FRAGMENT&q=1', 'https://login.example.com/?q=1'],
    ['https://a.example.com/?next=..%2Fcallback%3Ftoken%3Dsecret%26doc%3D7&q=1', 'https://a.example.com/?q=1'],
    ['https://onedrive.live.com/redir?resid=ABC123%21456&authkey=%21AbCdEfGh', 'https://onedrive.live.com/redir?resid=ABC123%21456'],
    ['https://drive.google.com/file/d/1AbCdEf/view?resourcekey=0-xYz123&usp=sharing', 'https://drive.google.com/file/d/1AbCdEf/view?usp=sharing'],
    ['https://x.example.com/?h=Bearer%2520CANARY&q=1', 'https://x.example.com/?q=1'],
    ['https://www.dropbox.com/scl/fi/x1y2z3/report.pdf?rlkey=k3x9d0n4q8y2b7m1v5c6z0a2f&dl=0', 'https://www.dropbox.com/scl/fi/x1y2z3/report.pdf?dl=0'],
    [
      'https://calendar.google.com/calendar/event?eid=NWg3ZzhqOWsxMGZkc2FfMjAyNjEwMTZUMDkwMDAwWiBhbmFAZXhhbXBsZS5jb20&tok=MTMjYW5hQGV4YW1wbGUuY29tNGE1YjZjN2Q4ZTlmMGExYjJjM2Q0ZTVm&ctz=Africa%2FKigali',
      'https://calendar.google.com/calendar/event?eid=NWg3ZzhqOWsxMGZkc2FfMjAyNjEwMTZUMDkwMDAwWiBhbmFAZXhhbXBsZS5jb20',
    ],
    ['https://checkout.example.com/return?session_id=cs_test_a1B2c3&payment_intent=pi_3Mtw&redirect_status=succeeded', 'https://checkout.example.com/return'],
    ['https://acme.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=AbCdEf123&apiKey=AIzaSyA&lang=en', 'https://acme.firebaseapp.com/__/auth/action?lang=en'],
    ['https://bucket.s3.amazonaws.com/a.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261017&X-Amz-Date=20261017T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123', 'https://bucket.s3.amazonaws.com/a.pdf'],
    ['https://storage.googleapis.com/b/a.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc&X-Goog-Signature=0a1b2c', 'https://storage.googleapis.com/b/a.pdf'],
    ['https://acct.blob.core.windows.net/c/a.pdf?sv=2022-11-02&se=2026-10-18&sr=b&sp=r&sig=AbC%2Bd%3D', 'https://acct.blob.core.windows.net/c/a.pdf'],
    ['https://app.slack.com/client/T01ABC/C02DEF?cdn_fallback=1&magic=xoxe-123', 'https://app.slack.com/client/T01ABC/C02DEF'],
    ['https://onedrive.live.com/redir?resid=ABC123%21456&cid=0f1e2d3c4b5a6978', 'https://onedrive.live.com/redir?resid=ABC123%21456&cid=0f1e2d3c4b5a6978'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing'],
    ['https://www.figma.com/design/AbC123dEf456GhI789jKl/Plan?node-id=12-345&m=dev', 'https://www.figma.com/design/AbC123dEf456GhI789jKl/Plan?node-id=12-345&m=dev'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&t=42s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&t=42s'],
    ['https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef?pvs=4', 'https://www.notion.so/acme/Plan-0123456789abcdef0123456789abcdef'],
    ['https://www.notion.so/acme?p=0123456789abcdef0123456789abcdef&pm=s', 'https://www.notion.so/acme'],
    ['https://www.amazon.com/s?k=iphone+15+pro+max+case&ref=nb_sb_noss', 'https://www.amazon.com/s?k=iphone+15+pro+max+case'],
    ['https://x.example.com/dl?h=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'https://x.example.com/dl'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanAddress(raw), want, raw)
})

test('Vimeo privacy hashes and encrypted tokens in state simply go', () => {
  assert.equal(cleanAddress('https://vimeo.com/123456789?h=a1b2c3d4e5&share=copy'), 'https://vimeo.com/123456789')
  assert.equal(cleanAddress('https://player.vimeo.com/video/123456789?h=a1b2c3d4e5'), 'https://player.vimeo.com/video/123456789')
  const jwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYtMTIzNDU2Nzg5.Y2lwaGVydGV4dC1hYmNkZWY.dGFnLTAxMjM0NTY3ODk'
  assert.equal(cleanAddress(`https://app.example.com/cb?state=${jwe}&page=2`), 'https://app.example.com/cb?page=2')
  assert.equal(cleanAddress(`https://app.example.com/cb?q=${jwe}&page=2`), 'https://app.example.com/cb?page=2', 'a direct-encryption JWE is a token in any kept parameter')
  assert.equal(cleanAddress(`https://app.example.com/cb?id=${jwe}`), 'https://app.example.com/cb')
})

test('German, Polish and other searches stay whatever their letters', () => {
  for (const q of [
    'KfzHaftpflichtVergleich2026',
    'Kraftfahrzeughaftpflichtversicherung2026',
    'Donaudampfschifffahrtsgesellschaft+Kapit%C3%A4n',
    'Rindfleischetikettierungs%C3%BCberwachungsaufgaben%C3%BCbertragungsgesetz',
    'WojewodztwoZachodniopomorskie2026',
    'GrzegorzBrzeczyszczykiewicz2026',
    'Szczebrzeszyn+chrz%C4%85szcz+brzmi+w+trzcinie',
    'Grzegorz+Brz%C4%99czyszczykiewicz',
    'iPhone15ProMaxCase2026',
    'basic+income',
    'Basic+Instinct',
    'bearer+market+2026',
  ])
    same(`https://www.google.com/search?q=${q}&hl=de`)
})

test('a credential in a kept parameter goes, in any encoding of its user name and password', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.c2lnbmF0dXJl'
  for (const v of [
    'Basic+am9z6Tpjb250cmFzZfFh',
    'Basic+YQBuAGEAOgBwAHcA',
    'Basic+dXNlcjpwYXNz',
    'basic%20YW5hOmh1bnRlcjI%3D',
    '%00Basic+Q0FOQVJZOnBhc3M%3D',
    'Bearer%2520CANARY',
    '%01%1fBearer+CANARY',
    'bearer%252520CANARY',
    'Bearer+abc.def',
    encodeURIComponent(encodeURIComponent(jwt)),
    'eyJhbGciOiJub25lIn0.e30.',
    'IHsiYWxnIjoiSFMyNTYiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlc2lnbmF0dXJl',
    'CnsiYWxnIjoiUlMyNTYifQ.e30.',
  ]) {
    assert.equal(cleanAddress(`https://x.example.com/?q=${v}&hl=en`), 'https://x.example.com/?hl=en', v)
    assert.equal(cleanAddress(`https://x.example.com/?id=${v}&hl=en`), 'https://x.example.com/?hl=en', v)
  }
  for (const kept of ['1.2.3', 'www.example.com', 'e30.e30.e30', 'eyJmb28iOiJiYXIifQ.e30.', 'basic+dXNlcnBhc3M']) same(`https://app.example.com/?q=${kept}`)
})

test('a key-shaped display setting goes; searches and identities keep their random-looking values', () => {
  assert.equal(cleanAddress('https://x.example.com/share?t=q8Z2kP0vLm3NcT7aB1sD4fGh&page=2'), 'https://x.example.com/share?page=2')
  assert.equal(cleanAddress('https://x.example.com/v?view=9f86d081884c7d659a2feaa0c55ad015&id=1'), 'https://x.example.com/v?id=1')
  same('https://www.youtube.com/channel/x?list=UCBJycsmduvYEL83R_U4JriQ')
  same('https://x.example.com/f?file=q8Z2kP0vLm3NcT7aB1sD4fGh')
})

test('an address inside a kept parameter stays as written when the rule would change nothing in it, and goes whole otherwise', () => {
  same('https://www.google.com/search?q=https%3A%2F%2Fapp.example.com%2Fcb%3Fdoc%3D7')
  same('https://a.example.com/?q=..%2Fcallback%3Fdoc%3D7')
  same('https://a.example.com/?q=.%2Fa%2F..%2Fb%3Fdoc%3D7')
  same('https://www.google.com/search?q=how+to+fix+this%3F')
  same('https://www.google.com/search?q=site%3Aexample.com+budget')
  same('https://shop.example.com/?q=50%25+off')
  const canary = 'https://u:CANARY@app.example/cb?access_token=CANARY#CANARY'
  for (const v of [
    'https://app.example.com/cb?token=abc&doc=7#frag',
    'https://app.example.com/cb?ref=newsletter',
    'https://me:pw@b.example.com/',
    'javascript:alert(1)',
    ' ' + canary,
    '\t' + canary + '\n',
    'callback?access_token=CANARY_TOKEN#CANARY_FRAGMENT',
    'cb/next?x=1&session=CANARY_TOKEN',
    'mailto:CANARY_PASSWORD@example.com?subject=CANARY_TOKEN',
    '\\\\evil.example?token=CANARY_TOKEN',
    '..%2Fcallback%3Ftoken%3Dsecret%26doc%3D7',
  ])
    assert.equal(cleanAddress('https://a.example.com/?q=' + encodeURIComponent(v) + '&hl=en'), 'https://a.example.com/?hl=en', v)
  for (const v of [
    encodeURIComponent(canary),
    encodeURIComponent(encodeURIComponent(canary)),
    '\u0000' + canary,
    '\u001f\u0001' + canary,
    '%00' + encodeURIComponent(canary),
    encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent(canary)))),
  ])
    assert.equal(cleanAddress('https://a.example.com/?q=' + encodeURIComponent(v) + '&hl=en'), 'https://a.example.com/?hl=en', JSON.stringify(v).slice(0, 60))
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


test('generic names keep only their own shape of value, and the ends-in-id catch-all is gone', () => {
  const cases: [string, string][] = [
    ['https://secure.na1.adobesign.com/public/esignWidget?wid=CBFCIBAA3AAABLblqZhB&pid=CBFCIBAA3AAABLblqZhA9x&tsid=CBFCIBAA3AAABLblqZhC7y', 'https://secure.na1.adobesign.com/public/esignWidget'],
    ['https://teams.microsoft.com/meet/2468013579?p=AbCdEfGh1234567', 'https://teams.microsoft.com/meet/2468013579'],
    ['https://na3.docusign.net/Signing/EmailStart.aspx?a=7c1e&acct=9d2f&er=3a4b&t=3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f', 'https://na3.docusign.net/Signing/EmailStart.aspx'],
    ['https://forum.example.com/thread?p=3&page=12', 'https://forum.example.com/thread?p=3&page=12'],
    ['https://forum.example.com/thread?page=abc&p=12a', 'https://forum.example.com/thread'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m30s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m30s'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m'],
    ['https://x.example.com/?t=abc&id=1', 'https://x.example.com/?id=1'],
    ['https://x.example.com/?t=s&id=1', 'https://x.example.com/?id=1'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanAddress(raw), want, raw)
  for (const name of ['pid', 'tsid', 'wid', 'fileId', 'video_id', 'userid', 'clientid', 'uid', 'src'])
    assert.equal(keptParam(name), null, name)
})

test('a display setting that is a UUID or long hex goes', () => {
  assert.equal(cleanAddress('https://x.example.com/?view=3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f&id=1'), 'https://x.example.com/?id=1')
  assert.equal(cleanAddress('https://x.example.com/?tab={3F2C1D4E-5B6A-4C7D-8E9F-0A1B2C3D4E5F}&id=1'), 'https://x.example.com/?id=1')
  assert.equal(cleanAddress('https://x.example.com/?filter=abcdefabcdefabcdefabcdefabcdefab&id=1'), 'https://x.example.com/?id=1')
  same('https://x.example.com/?sort=price&tab=files&view=grid&id=3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f')
})

test('the named search and identity parameters of common sites stay; calendar src and new tracking IDs go', () => {
  same('https://www.youtube.com/results?search_query=lofi+beats')
  same('https://pubmed.ncbi.nlm.nih.gov/?term=crispr+off-target')
  assert.equal(cleanAddress('https://www.ebay.com/sch/i.html?_nkw=lego+technic&_sacat=0'), 'https://www.ebay.com/sch/i.html?_nkw=lego+technic')
  assert.equal(
    cleanAddress('https://acme.sharepoint.com/:w:/r/sites/x/_layouts/15/Doc.aspx?sourcedoc=%7B12345678-1234-1234-1234-123456789ABC%7D&file=Plan.docx&action=default'),
    'https://acme.sharepoint.com/:w:/r/sites/x/_layouts/15/Doc.aspx?sourcedoc=%7B12345678-1234-1234-1234-123456789ABC%7D&file=Plan.docx',
  )
  same('https://mail.google.com/mail/u/0/?th=18c2f3a4b5d6e7f8')
  assert.equal(cleanAddress('https://calendar.google.com/calendar/embed?src=ana%40example.com&ctz=UTC'), 'https://calendar.google.com/calendar/embed')
  assert.equal(cleanAddress('https://shop.example.com/p?gbraid=0AAAAAo&wbraid=CjkKCQ&q=shoes'), 'https://shop.example.com/p?q=shoes')
  const tracking = '_ga _gl gclid gclsrc dclid gbraid wbraid fbclid msclkid ttclid twclid li_fat_id yclid ysclid igshid srsltid mc_cid mc_eid _hsenc _hsmi __hssc __hstc hsCtaTracking mkt_tok oly_enc_id oly_anon_id vero_id vero_conv rb_clickid s_kwcid ef_id _openstat trk trkCampaign cmpid campaignid campaign_id adgroupid adid ad_id creative keyword matchtype network device placement utm_source utm_medium utm_campaign utm_term utm_content utm_id ref ref_src ref_url si spm scm share_id feature pp sxsrf ved ei gs_lcrp sca_esv rlz oq aqs sourceid ie uact zx'
  for (const name of tracking.split(' ')) assert.equal(keptParam(name), null, name)
})

test('short search aliases keep only text; every search drops a JSON object or array', () => {
  const lynx = '%7B%22u%22%3A%22ana%40example.com%22%2C%22c%22%3A%22CANARY_CRED_7f3a%22%7D'
  const cases: [string, string][] = [
    ['https://assets.imgix.net/photo.jpg?w=800&s=9f86d081884c7d659a2feaa0c55ad015', 'https://assets.imgix.net/photo.jpg'],
    [`https://app.lynxlog.example/login?k=${lynx}`, 'https://app.lynxlog.example/login'],
    ['https://app.lynxlog.example/login?k=eyJ1IjoiYW5hQGV4YW1wbGUuY29tIiwiYyI6IkNBTkFSWV9DUkVEXzdmM2EifQ', 'https://app.lynxlog.example/login'],
    ['https://x.example.com/?s=q8Z2kP0vLm3NcT7aB1sD4fGh', 'https://x.example.com/'],
    [`https://x.example.com/?q=${lynx}&hl=en`, 'https://x.example.com/?hl=en'],
    [`https://x.example.com/?query=%5B%22CANARY%22%2C1%5D&hl=en`, 'https://x.example.com/?hl=en'],
    [`https://x.example.com/?search=${encodeURIComponent(lynx)}&hl=en`, 'https://x.example.com/?hl=en'],
  ]
  for (const [raw, want] of cases) assert.equal(cleanAddress(raw), want, raw)
  same('https://blog.example.com/?s=quarterly+report+2026')
  same('https://www.amazon.com/s?k=iphone+15+pro+max+case')
  same('https://www.amazon.com/s?k=Kraftfahrzeughaftpflichtversicherung')
  same('https://www.amazon.de/s?k=Kinderwagenregenschutz')
  same('https://blog.example.com/?s=SchwarzwaelderKirschtorte')
  assert.equal(cleanAddress('https://www.amazon.com/s?k=iPhone15ProMaxCase2026'), 'https://www.amazon.com/s', 'one key-shaped token in a short alias goes')
  same('https://www.google.com/search?q=iPhone15ProMaxCase2026')
  same('https://www.google.com/search?q=q8Z2kP0vLm3NcT7aB1sD4fGh')
  same('https://www.google.com/search?q=%7Bnot+json%7D')
})

