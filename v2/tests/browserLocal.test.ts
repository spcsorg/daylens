import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import Database from 'better-sqlite3'
import type { AddressInfo } from 'node:net'
import { connectLocal, type WsLike } from '../browser/extension/src/local.ts'
import { BrowserPages } from '../capture/browser.ts'
import { BrowserLocal, type ConfirmRequest, type PeerCheck } from '../capture/browserLocal.ts'
import { Privacy } from '../capture/normalize.ts'
import { newPairing, pairLink, type Pairing } from '../capture/pairing.ts'
import { memorySecrets, type SecretStore } from '../capture/secrets.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import { app, focus } from './support/lines.ts'
import { MemoryPause } from './support/memoryPause.ts'
import { MemorySink } from './support/memorySink.ts'

const ORIGIN = 'chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg'
const chrome = app('com.google.Chrome', { pid: 500, registered_browser: true, name: 'Google Chrome' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Sink extends MemorySink {
  m = new Map<string, string>()
  meta(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setMeta(k: string, v: string | null): void {
    if (v === null) this.m.delete(k)
    else this.m.set(k, v)
  }
}

async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = []
  const servers: http.Server[] = []
  for (let i = 0; i < n; i++) {
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    ports.push((s.address() as AddressInfo).port)
    servers.push(s)
  }
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  return ports
}

async function service(ports: number[], peer: PeerCheck = async () => ({ ok: true, browser: chrome }), asks: ConfirmRequest[] = [], front = chrome, secrets: SecretStore = memorySecrets(), sink = new Sink()) {
  const privacy = new Privacy([])
  const pages = new BrowserPages(sink, privacy)
  const pause = new MemoryPause()
  const norm = new ServiceNormalizer(sink, privacy, pages)
  norm.handle(focus(front, null, Date.now() - 1000, 'app_changed'))
  const logs: string[] = []
  const local = new BrowserLocal(pages, pause, sink, { ports, peerCheck: peer, clock: () => norm.clock(), log: (m) => logs.push(m), handshakeMs: 2000, confirm: (r) => asks.push(r), secrets })
  assert.ok(await local.start())
  return { sink, local, logs, norm, pause }
}

// The extension's WebSocket, as a browser makes it: the Origin header is the extension's and cannot be set by a page.
const extensionWs = (origin = ORIGIN) => (url: string) => new WebSocket(url, { headers: { origin } } as never) as unknown as WsLike

async function connect(ports: number[], pairing: Pairing, origin = ORIGIN, onAwaiting?: () => void) {
  const got: Record<string, unknown>[] = []
  const r = await connectLocal(extensionWs(origin), pairing, (m) => got.push(m), () => {}, { ports, attemptMs: 1500, keepaliveMs: 60_000, onAwaiting })
  return { r, got }
}

test('a paired extension connects, proves, and its pages reach the page gate', async () => {
  const [p] = await freePorts(1)
  const { sink, local, logs } = await service([p!])
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const { r, got } = await connect([p!], pairing)
  assert.equal(r.kind, 'connected')
  if (r.kind !== 'connected') return
  assert.deepEqual(got[0], { t: 'status', daylens: 'connected', capture: 'running', until_wall_ms: null })
  r.session.send({ t: 'tab', trigger: 'snapshot', state: 'page', window: '1', tab: '2', url: 'https://example.com/a?token=x', title: 'A' })
  await sleep(150)
  assert.deepEqual(sink.rows.filter((x) => x.kind === 'page').map((x) => [x.state, x.url]), [['normal', 'https://example.com/a']])
  assert.ok(logs.includes('browser pairing confirmed replaced=0'))
  assert.ok(!logs.includes('browser pairing awaiting confirmation'), 'a Chromium origin is never asked about')
  r.session.close()
  await local.stop()
})

test('a pause from the extension pauses only the browser it runs in, named by the peer check', async () => {
  const [p] = await freePorts(1)
  const { local, pause } = await service([p!])
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const { r, got } = await connect([p!], pairing)
  assert.equal(r.kind, 'connected')
  if (r.kind !== 'connected') return
  r.session.send({ t: 'pause', until_wall_ms: 1_792_134_000_000 } as never)
  await sleep(150)
  assert.deepEqual(pause.browsers, [{ app_id: 'com.google.Chrome', until_wall_ms: 1_792_134_000_000 }])
  r.session.send({ t: 'resume' } as never)
  r.session.send({ t: 'pause', until_wall_ms: 'tomorrow' } as never)
  await sleep(150)
  assert.deepEqual(pause.browsers, [])
  assert.ok(got.filter((m) => m.t === 'status').length >= 3, 'each request is answered with the current status')
  r.session.close()
  await local.stop()
})

test('a server without the secret never gets a proof or a page from the extension', async () => {
  const [p] = await freePorts(1)
  const { local, logs } = await service([p!])
  const real = newPairing(ORIGIN)
  // The impostor knows the pairing ID (it is not secret) but holds a different key.
  local.addPairLink(pairLink({ ...newPairing(ORIGIN), id: real.id }))
  const { r } = await connect([p!], real)
  assert.equal(r.kind, 'unreachable')
  await sleep(100)
  assert.ok(!logs.some((l) => l.includes('bad_proof')), 'the extension stopped before sending its proof')
  assert.ok(!logs.some((l) => l.startsWith('browser connected')))
  await local.stop()
})

test('a squatter on the first port only moves the extension along to the next one', async () => {
  const [squatPort, realPort] = await freePorts(2)
  // A program on the first port that accepts the WebSocket and answers with a challenge it cannot back.
  const squatter = http.createServer()
  let squatterGotProof = false
  const held: import('node:net').Socket[] = []
  squatter.on('upgrade', (req, socket) => {
    held.push(socket as import('node:net').Socket)
    const key = req.headers['sec-websocket-key'] as string
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', (d: Buffer) => {
      if (d.length > 6) {
        const mask = d.subarray(2, 6)
        const body = Buffer.from(d.subarray(6).map((b, i) => b ^ mask[i % 4]!)).toString()
        if (body.includes('"proof"')) squatterGotProof = true
        if (body.includes('"hello"')) {
          const msg = Buffer.from(JSON.stringify({ t: 'challenge', v: 1, nonce: 'A'.repeat(43), proof: 'B'.repeat(43) }))
          socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]))
        }
      }
    })
  })
  await new Promise<void>((r) => squatter.listen(squatPort, '127.0.0.1', () => r()))
  const { local } = await service([squatPort!, realPort!])
  assert.equal(local.port, realPort, 'Daylens moved past the taken port')
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const { r } = await connect([squatPort!, realPort!], pairing)
  assert.equal(r.kind, 'connected')
  if (r.kind === 'connected') assert.equal(r.session.port, realPort)
  assert.equal(squatterGotProof, false)
  if (r.kind === 'connected') r.session.close()
  await local.stop()
  for (const s of held) s.destroy()
  await new Promise<void>((res) => squatter.close(() => res()))
})

test('a web page origin is refused before the WebSocket opens', async () => {
  const [p] = await freePorts(1)
  const { local, logs } = await service([p!])
  for (const origin of ['https://evil.example', 'null', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop']) {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/daylens/browser`, { headers: { origin } } as never)
    const opened = await new Promise<boolean>((r) => {
      ws.onopen = () => r(true)
      ws.onerror = () => r(false)
    })
    assert.equal(opened, false, origin)
  }
  assert.equal(logs.filter((l) => l === 'browser local refused reason=origin').length, 3)
  await local.stop()
})

test('a peer owned by another user is closed before any pairing is looked at', async () => {
  const [p] = await freePorts(1)
  const { local, logs } = await service([p!], async () => ({ ok: false, reason: 'other_user' }))
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const { r } = await connect([p!], pairing)
  assert.equal(r.kind, 'unreachable')
  assert.ok(logs.includes('browser local refused reason=peer_other_user'))
  assert.ok(!logs.some((l) => l.startsWith('browser pairing confirmed')))
  await local.stop()
})

test('a pairing link opened by a web page never displaces the real pairing and cannot be proven by a page', async () => {
  const [p] = await freePorts(1)
  const { local, logs } = await service([p!])
  const real = newPairing(ORIGIN)
  local.addPairLink(pairLink(real))
  const first = await connect([p!], real)
  assert.equal(first.r.kind, 'connected')
  if (first.r.kind === 'connected') first.r.session.close()

  // The page names our extension's origin with a key it chose, and floods links.
  const forged = newPairing(ORIGIN)
  for (let i = 0; i < 20; i++) local.addPairLink(pairLink(i === 0 ? forged : newPairing(ORIGIN)))
  assert.ok(!local.addPairLink('daylens://pair?v=1&id=x&key=y&origin=https%3A%2F%2Fevil.example'))
  // A page cannot send the extension's Origin, so its connection is refused before the forged key is ever tried.
  const page = await connect([p!], forged, 'https://evil.example')
  assert.equal(page.r.kind, 'unreachable')

  const again = await connect([p!], real)
  assert.equal(again.r.kind, 'connected', 'the real pairing still works')
  assert.equal(local.pairings().length, 1)
  assert.ok(!logs.some((l) => /pairing confirmed replaced=[1-9]/.test(l)))
  if (again.r.kind === 'connected') again.r.session.close()
  await local.stop()
})

const FIREFOX = 'moz-extension://11111111-1111-4111-8111-111111111111'
const OTHER_FIREFOX_EXTENSION = 'moz-extension://22222222-2222-4222-8222-222222222222'
const firefox = app('org.mozilla.firefox', { pid: 600, registered_browser: true, name: 'Firefox' })

test('a new Firefox pairing waits for Allow in Daylens and sends no page before it', async () => {
  const [p] = await freePorts(1)
  const asks: ConfirmRequest[] = []
  const { sink, local, logs } = await service([p!], async () => ({ ok: true, browser: firefox }), asks, firefox)
  const pairing = newPairing(FIREFOX)
  local.addPairLink(pairLink(pairing))
  let awaited = false
  const pending = connect([p!], pairing, FIREFOX, () => (awaited = true))
  await sleep(300)
  assert.ok(awaited, 'the extension was told to wait')
  assert.deepEqual(asks, [{ op: 'confirm_pairing', id: pairing.id, browser: 'Firefox' }])
  assert.equal(local.pairings().length, 0, 'not stored before Allow')
  assert.ok(!logs.some((l) => l.startsWith('browser connected')))
  await sleep(1700)
  assert.ok(local.decide(pairing.id, true))
  const { r } = await pending
  assert.equal(r.kind, 'connected', 'the held connection survives past the usual attempt time and completes on Allow')
  assert.equal(local.pairings().length, 1)
  if (r.kind === 'connected') {
    r.session.send({ t: 'tab', trigger: 'snapshot', state: 'page', window: '1', tab: '2', url: 'https://example.com/f', title: 'F' })
    await sleep(150)
    assert.deepEqual(sink.rows.filter((x) => x.kind === 'page').map((x) => x.url), ['https://example.com/f'])
    r.session.close()
  }
  const again = await connect([p!], pairing, FIREFOX)
  assert.equal(again.r.kind, 'connected', 'a stored pairing is not asked about again')
  assert.equal(asks.length, 1)
  if (again.r.kind === 'connected') again.r.session.close()
  await local.stop()
})

test("Don't allow ends the pairing; the extension learns it and the pairing can never connect", async () => {
  const [p] = await freePorts(1)
  const asks: ConfirmRequest[] = []
  const { local, logs } = await service([p!], async () => ({ ok: true, browser: firefox }), asks, firefox)
  const pairing = newPairing(FIREFOX)
  local.addPairLink(pairLink(pairing))
  const pending = connect([p!], pairing, FIREFOX)
  await sleep(300)
  assert.ok(local.decide(pairing.id, false))
  assert.equal((await pending).r.kind, 'denied')
  assert.ok(logs.includes('browser pairing denied'))
  assert.equal((await connect([p!], pairing, FIREFOX)).r.kind, 'unpaired')
  assert.equal(local.decide(pairing.id, true), false, 'a late answer for a dropped pairing does nothing')
  await local.stop()
})

test('another Firefox extension that pairs itself gets nowhere without Allow', async () => {
  const [p] = await freePorts(1)
  const asks: ConfirmRequest[] = []
  const { sink, local } = await service([p!], async () => ({ ok: true, browser: firefox }), asks, firefox)
  const intruder = newPairing(OTHER_FIREFOX_EXTENSION)
  local.addPairLink(pairLink(intruder))
  const pending = connect([p!], intruder, OTHER_FIREFOX_EXTENSION)
  await sleep(300)
  assert.equal(asks.length, 1, 'the person is asked; nothing happens on its own')
  await local.stop()
  assert.notEqual((await pending).r.kind, 'connected')
  assert.equal(local.pairings().length, 0)
  assert.equal(sink.rows.filter((x) => x.kind === 'page').length, 0)
})

test('Allow given after the waiting connection closed lets the next one through without asking again', async () => {
  const [p] = await freePorts(1)
  const asks: ConfirmRequest[] = []
  const { local } = await service([p!], async () => ({ ok: true, browser: firefox }), asks, firefox)
  const pairing = newPairing(FIREFOX)
  local.addPairLink(pairLink(pairing))
  const ws = connect([p!], pairing, FIREFOX)
  await sleep(300)
  await local.stop()
  await ws
  assert.ok(await local.start())
  assert.ok(local.decide(pairing.id, true))
  const next = await connect([p!], pairing, FIREFOX)
  assert.equal(next.r.kind, 'connected')
  assert.equal(asks.length, 1)
  if (next.r.kind === 'connected') next.r.session.close()
  await local.stop()
})

// A raw WebSocket server that never holds the secret: answers hello with a made-up challenge and, in the same write,
// a status, then records every frame the client sends afterwards.
async function impostor(port: number, extra: object[] = [{ t: 'status', daylens: 'connected', capture: 'running', until_wall_ms: null }]) {
  const got: string[] = []
  const held: import('node:net').Socket[] = []
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    held.push(socket as import('node:net').Socket)
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const frame = (o: object) => {
      const b = Buffer.from(JSON.stringify(o))
      const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 0xff])
      return Buffer.concat([head, b])
    }
    socket.on('data', (d: Buffer) => {
      if ((d[0]! & 0x0f) !== 1 || d.length < 6) return
      const len = d[1]! & 0x7f
      const off = len === 126 ? 4 : 2
      const n = len === 126 ? d.readUInt16BE(2) : len
      const mask = d.subarray(off, off + 4)
      const body = Buffer.from(d.subarray(off + 4, off + 4 + n).map((x, i) => x ^ mask[i % 4]!)).toString()
      got.push(body)
      if (body.includes('"hello"')) socket.write(Buffer.concat([frame({ t: 'challenge', v: 1, nonce: 'A'.repeat(43), proof: 'B'.repeat(43) }), ...extra.map(frame)]))
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  return {
    got,
    close: async () => {
      for (const s of held) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

test('a server without the secret cannot get a session by sending status right behind its challenge', async () => {
  const [p] = await freePorts(1)
  const fake = await impostor(p!)
  const pairing = newPairing(ORIGIN)
  const { r } = await connect([p!], pairing)
  if (r.kind === 'connected') r.session.send({ t: 'tab', trigger: 'snapshot', state: 'page', window: '1', tab: '1', url: 'https://canary.example/secret', title: 'canary' })
  await sleep(200)
  assert.notEqual(r.kind, 'connected')
  assert.deepEqual(fake.got.map((g) => JSON.parse(g).t), ['hello'], 'nothing but hello reaches a server that cannot prove the secret')
  await fake.close()
})


test('malformed frames before and during authentication close that connection and nothing else', async () => {
  const [p] = await freePorts(1)
  const rejections: unknown[] = []
  const onRejection = (e: unknown) => rejections.push(e)
  process.on('unhandledRejection', onRejection)
  try {
    // A slow peer check, so frames arrive while it is still running.
    const { local, logs } = await service([p!], async () => {
      await sleep(300)
      return { ok: true, browser: chrome }
    })
    const pairing = newPairing(ORIGIN)
    local.addPairLink(pairLink(pairing))
    const send = async (frames: string[], afterHello: boolean) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/daylens/browser`, { headers: { origin: ORIGIN } } as never)
      await new Promise<void>((r) => (ws.onopen = () => r()))
      if (afterHello) ws.send(JSON.stringify({ t: 'hello', v: 1, pair: pairing.id, nonce: 'N'.repeat(43) }))
      for (const f of frames) ws.send(f)
      return new Promise<number>((r) => (ws.onclose = (e) => r(e.code)))
    }
    for (const bad of ['null', '[]', '5', '"x"', 'true', '{"t":null}', '{"t":"hello","pair":{},"nonce":[]}', '{"t":"proof","proof":null}'])
      for (const afterHello of [false, true]) {
        const code = await send([bad], afterHello)
        assert.ok(code !== 1000 || afterHello, `${bad} afterHello=${afterHello} closed with ${code}`)
      }
    await sleep(400)
    assert.deepEqual(rejections, [], 'no handler failure escapes')
    const { r } = await connect([p!], pairing)
    assert.equal(r.kind, 'connected', 'the service still works')
    if (r.kind === 'connected') r.session.close()
    assert.ok(logs.some((l) => l.startsWith('browser local refused reason=')))
    await local.stop()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('pairing keys live in the secret store; the database keeps only ids, origins and times', async () => {
  const [p] = await freePorts(1)
  const secrets = memorySecrets()
  const { sink, local } = await service([p!], undefined, [], chrome, secrets)
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const first = await connect([p!], pairing)
  assert.equal(first.r.kind, 'connected')
  if (first.r.kind === 'connected') first.r.session.close()
  await local.stop()
  const meta = sink.meta('browser_pairings') ?? ''
  assert.ok(!meta.includes(pairing.key), 'no key material in the database')
  assert.deepEqual(Object.keys(JSON.parse(meta)[0]).sort(), ['id', 'origin', 'paired_wall_ms'])
  assert.equal(secrets.items.get(pairing.id), pairing.key)

  // A restart reads the key back from the secret store.
  const again = await service([p!], undefined, [], chrome, secrets, sink)
  const second = await connect([p!], pairing)
  assert.equal(second.r.kind, 'connected')
  if (second.r.kind === 'connected') second.r.session.close()
  // Unpairing removes the secret too.
  assert.ok(again.local.unpair(pairing.id))
  await sleep(20)
  assert.equal(secrets.items.has(pairing.id), false)
  await again.local.stop()
})

test('a key left in the database by an earlier version moves to the secret store at start', async () => {
  const [p] = await freePorts(1)
  const sink = new Sink()
  const pairing = newPairing(ORIGIN)
  sink.setMeta('browser_pairings', JSON.stringify([{ id: pairing.id, key: pairing.key, origin: ORIGIN, paired_wall_ms: 1 }]))
  const secrets = memorySecrets()
  const { local } = await service([p!], undefined, [], chrome, secrets, sink)
  assert.ok(!(sink.meta('browser_pairings') ?? '').includes(pairing.key))
  assert.equal(secrets.items.get(pairing.id), pairing.key)
  const { r } = await connect([p!], pairing)
  assert.equal(r.kind, 'connected')
  if (r.kind === 'connected') r.session.close()
  await local.stop()
})

test('a pairing whose secret is gone from secure storage is unpaired, never trusted', async () => {
  const [p] = await freePorts(1)
  const secrets = memorySecrets()
  const { local, sink } = await service([p!], undefined, [], chrome, secrets)
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const first = await connect([p!], pairing)
  assert.equal(first.r.kind, 'connected')
  if (first.r.kind === 'connected') first.r.session.close()
  await local.stop()
  secrets.items.clear()
  const after = await service([p!], undefined, [], chrome, secrets, sink)
  assert.equal((await connect([p!], pairing)).r.kind, 'unpaired')
  assert.equal(after.local.pairings().length, 0, 'the record without a secret is removed')
  await after.local.stop()
})


test('after a legacy key moves to secure storage, its bytes are gone from the database files', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Store, DB_FILE } = await import('../capture/store.ts')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-scrub-'))
  const store = new Store(dir)
  const pairing = newPairing(ORIGIN)
  store.setMeta('browser_pairings', JSON.stringify([{ id: pairing.id, key: pairing.key, origin: ORIGIN, paired_wall_ms: 1 }]))
  store.flush()
  const [p] = await freePorts(1)
  const privacy = new Privacy([])
  const pages = new BrowserPages(store, privacy)
  const local = new BrowserLocal(pages, new MemoryPause(), store, { ports: [p!], peerCheck: async () => ({ ok: true, browser: chrome }), clock: () => null, secrets: memorySecrets() })
  assert.ok(await local.start())
  await local.stop()
  const bytes = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((f) => path.join(dir, f)).filter((f) => existsSync(f)).map((f) => readFileSync(f))
  store.close()
  for (const b of bytes) assert.equal(b.includes(Buffer.from(pairing.key)), false, 'no copy of the key anywhere in the files')
})

test('a scrub blocked by an open reader stays pending, shows in health, and finishes once the reader is gone', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Store, DB_FILE } = await import('../capture/store.ts')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-scrub-busy-'))
  const store = new Store(dir)
  const pairing = newPairing(ORIGIN)
  store.setMeta('browser_pairings', JSON.stringify([{ id: pairing.id, key: pairing.key, origin: ORIGIN, paired_wall_ms: 1 }]))
  store.flush()
  // Another reader (the app, say) holds a snapshot that still contains the key.
  const reader = new Database(path.join(dir, DB_FILE), { readonly: true })
  reader.prepare('BEGIN').run()
  reader.prepare('SELECT count(*) FROM meta').get()
  const [p] = await freePorts(1)
  const local = new BrowserLocal(new BrowserPages(store, new Privacy([])), new MemoryPause(), store, { ports: [p!], peerCheck: async () => ({ ok: true, browser: chrome }), clock: () => null, secrets: memorySecrets() })
  assert.ok(await local.start())
  await local.stop()
  assert.equal(store.storeHealth().scrubPending, true, 'the scrub could not finish and says so')
  assert.equal(store.meta('scrub_pending'), '1')
  reader.prepare('COMMIT').run()
  reader.close()
  assert.equal(store.retryScrub(), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(store.meta('scrub_pending'), null)
  const files = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((f) => path.join(dir, f)).filter((f) => existsSync(f))
  for (const f of files) assert.equal(readFileSync(f).includes(Buffer.from(pairing.key)), false, f)
  store.close()
})

test('unpairing while a reconnect waits on secure storage refuses that reconnect', async () => {
  const [p] = await freePorts(1)
  const inner = memorySecrets()
  let slow = false
  const secrets: SecretStore = {
    set: (n, k) => inner.set(n, k),
    get: async (n) => {
      const key = await inner.get(n)
      if (slow) await sleep(300)
      return key
    },
    delete: (n) => inner.delete(n),
  }
  const { local } = await service([p!], undefined, [], chrome, secrets)
  const pairing = newPairing(ORIGIN)
  local.addPairLink(pairLink(pairing))
  const first = await connect([p!], pairing)
  if (first.r.kind === 'connected') first.r.session.close()
  // A restart: the key is no longer cached and has to come from the slow store.
  await local.stop()
  const { local: after, sink } = await service([p!], undefined, [], chrome, secrets, (local as unknown as { store: Sink }).store)
  slow = true
  const reconnect = connect([p!], pairing)
  await sleep(100)
  assert.ok(after.unpair(pairing.id))
  const { r } = await reconnect
  assert.notEqual(r.kind, 'connected', 'the reconnect that was waiting does not get through')
  assert.equal(after.pairings().length, 0)
  assert.equal(inner.items.has(pairing.id), false)
  void sink
  await after.stop()
})
