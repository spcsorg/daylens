// The extension's side of the local connection. It tries each port in turn and keeps a server only after that server
// proves it holds the pairing secret; a server that cannot (another program on the port, another user's process)
// is closed and the next port is tried. Nothing about pages is sent before the proof, and the secret is never sent.

import { LOCAL_PATH, LOCAL_PORTS, isNonce, proof, randomB64url, sameProof, transcript, type Pairing } from '../../../capture/pairing.ts'

export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type WsFactory = (url: string) => WsLike

export interface Session {
  port: number
  send(msg: object): void
  close(): void
}

export type ConnectResult = { kind: 'connected'; session: Session } | { kind: 'unpaired' } | { kind: 'denied' } | { kind: 'unreachable' }

export interface LocalOptions {
  ports?: readonly number[]
  // How long one port gets to finish the handshake.
  attemptMs?: number
  keepaliveMs?: number
  // Daylens holds the connection until the person allows this browser (Firefox).
  onAwaiting?: () => void
}

// The service worker stays alive while messages flow; Chrome stops an idle one after 30 s.
const KEEPALIVE_MS = 20_000
const ATTEMPT_MS = 5_000

type Outcome = { kind: 'connected'; session: Session } | { kind: 'unpaired' } | { kind: 'denied' } | { kind: 'failed' }

function attempt(
  open: WsFactory,
  port: number,
  pairing: Pairing,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose: () => void,
  opts: Required<Omit<LocalOptions, 'onAwaiting'>> & Pick<LocalOptions, 'onAwaiting'>,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let ws: WsLike
    try {
      ws = open(`ws://127.0.0.1:${port}${LOCAL_PATH}`)
    } catch {
      return resolve({ kind: 'failed' })
    }
    const extNonce = randomB64url(32)
    // Each message is handled to the end before the next one is looked at, and nothing but a status that follows our
    // own proof (which we send only after the service proved itself) opens the session.
    let phase: 'open' | 'challenge' | 'verifying' | 'status' | 'ready' | 'done' = 'open'
    let keepalive: ReturnType<typeof setInterval> | null = null
    let settled = false
    const settle = (o: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(o)
    }
    // Any failure closes the socket, in every phase, including after the session was handed out.
    const fail = (o: Outcome = { kind: 'failed' }) => {
      const wasReady = phase === 'ready'
      phase = 'done'
      if (keepalive) clearInterval(keepalive)
      try {
        ws.close()
      } catch {}
      if (wasReady) onClose()
      settle(o)
    }
    const timer = setTimeout(() => fail(), opts.attemptMs)
    ws.onopen = () => {
      if (phase !== 'open') return
      phase = 'challenge'
      ws.send(JSON.stringify({ t: 'hello', v: 1, pair: pairing.id, nonce: extNonce }))
    }
    ws.onerror = () => fail()
    ws.onclose = () => {
      if (phase === 'done') return
      fail()
    }
    const handle = async (data: unknown): Promise<void> => {
      if (phase === 'done') return
      if (typeof data !== 'string') return fail()
      let msg: unknown
      try {
        msg = JSON.parse(data)
      } catch {
        return fail()
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail()
      const m = msg as Record<string, unknown>
      if (phase === 'ready') return onMessage(m)
      if (phase === 'challenge') {
        if (m.t === 'unpaired') return fail({ kind: 'unpaired' })
        if (m.t !== 'challenge' || !isNonce(m.nonce)) return fail()
        phase = 'verifying'
        const svcNonce = m.nonce
        const want = await proof(pairing.key, transcript('service', pairing.origin, port, pairing.id, extNonce, svcNonce))
        if (phase !== 'verifying') return
        if (!sameProof(m.proof, want)) return fail()
        const mine = await proof(pairing.key, transcript('extension', pairing.origin, port, pairing.id, extNonce, svcNonce))
        if (phase !== 'verifying') return
        ws.send(JSON.stringify({ t: 'proof', proof: mine }))
        phase = 'status'
        return
      }
      if (phase !== 'status') return fail()
      // The service answers our proof with its status; only then is the connection used.
      if (m.t === 'awaiting') {
        clearTimeout(timer)
        opts.onAwaiting?.()
        return
      }
      if (m.t === 'denied') return fail({ kind: 'denied' })
      if (m.t !== 'status') return fail()
      const session: Session = {
        port,
        send: (x) => {
          if (phase === 'ready' && ws.readyState === 1) ws.send(JSON.stringify(x))
        },
        close: () => {
          if (phase === 'ready') fail()
        },
      }
      phase = 'ready'
      keepalive = setInterval(() => session.send({ t: 'ping' }), opts.keepaliveMs)
      settle({ kind: 'connected', session })
      onMessage(m)
    }
    let queue = Promise.resolve()
    ws.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data)).catch(() => fail())
    }
  })
}

export async function connectLocal(
  open: WsFactory,
  pairing: Pairing,
  onMessage: (msg: Record<string, unknown>) => void,
  onClose: () => void,
  options: LocalOptions = {},
): Promise<ConnectResult> {
  const opts = { ports: options.ports ?? LOCAL_PORTS, attemptMs: options.attemptMs ?? ATTEMPT_MS, keepaliveMs: options.keepaliveMs ?? KEEPALIVE_MS, onAwaiting: options.onAwaiting }
  let unpaired = false
  for (const port of opts.ports) {
    const o = await attempt(open, port, pairing, onMessage, onClose, opts)
    if (o.kind === 'connected' || o.kind === 'denied') return o
    if (o.kind === 'unpaired') unpaired = true
  }
  return unpaired ? { kind: 'unpaired' } : { kind: 'unreachable' }
}
