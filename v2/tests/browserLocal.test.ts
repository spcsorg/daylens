import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectLocal, type WsLike } from '../browser/extension/src/local.ts'
import { BrowserPages } from '../capture/browser.ts'
import { BrowserLocal, type ConfirmRequest, type PeerCheck } from '../capture/browserLocal.ts'
import { Privacy } from '../capture/normalize.ts'
import { newPairing, pairLink, type Pairing } from '../capture/pairing.ts'
import { Pause } from '../capture/pause.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import { app, focus } from './support/lines.ts'
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

async function service(ports: number[], peer: PeerCheck = async () => ({ ok: true, browser: chrome }), asks: ConfirmRequest[] = [], front = chrome) {
  const sink = new Sink()
  const privacy = new Privacy([])
  const pages = new BrowserPages(sink, privacy)
  const pause = new Pause(sink)
  const norm = new ServiceNormalizer(sink, privacy, pause, pages)
  norm.handle(focus(front, null, Date.now() - 1000, 'app_changed'))
  const logs: string[] = []
  const local = new BrowserLocal(pages, pause, sink, { ports, peerCheck: peer, clock: () => norm.clock(), log: (m) => logs.push(m), handshakeMs: 2000, confirm: (r) => asks.push(r) })
  assert.ok(await local.start())
  return { sink, local, logs, norm }
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

