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
    let phase: 'open' | 'challenge' | 'status' | 'ready' | 'done' = 'open'
    let keepalive: ReturnType<typeof setInterval> | null = null
    const finish = (o: Outcome) => {
      if (phase === 'done' || phase === 'ready') return
      clearTimeout(timer)
      if (o.kind !== 'connected') {
        phase = 'done'
        try {
          ws.close()
        } catch {}
      }
      resolve(o)
    }
    const timer = setTimeout(() => finish({ kind: 'failed' }), opts.attemptMs)
    ws.onopen = () => {
      phase = 'challenge'
      ws.send(JSON.stringify({ t: 'hello', v: 1, pair: pairing.id, nonce: extNonce }))
    }
    ws.onerror = () => finish({ kind: 'failed' })
    ws.onclose = () => {
      if (keepalive) clearInterval(keepalive)
      if (phase === 'ready') {
        phase = 'done'
        onClose()
      } else finish({ kind: 'failed' })
    }
    ws.onmessage = async (ev) => {
      if (typeof ev.data !== 'string') return finish({ kind: 'failed' })
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return finish({ kind: 'failed' })
      }
      if (phase === 'ready') return onMessage(msg)
      if (phase === 'challenge') {
        if (msg.t === 'unpaired') return finish({ kind: 'unpaired' })
        if (msg.t !== 'challenge' || !isNonce(msg.nonce)) return finish({ kind: 'failed' })
        phase = 'status'
        const svcNonce = msg.nonce
        const want = await proof(pairing.key, transcript('service', pairing.origin, port, pairing.id, extNonce, svcNonce))
        if (!sameProof(msg.proof, want)) return finish({ kind: 'failed' })
        const mine = await proof(pairing.key, transcript('extension', pairing.origin, port, pairing.id, extNonce, svcNonce))
        if (phase !== 'status') return
        ws.send(JSON.stringify({ t: 'proof', proof: mine }))
        return
      }
      if (phase === 'status') {
        // The service answers a good proof with its status; only then is the connection used.
        if (msg.t === 'awaiting') {
          clearTimeout(timer)
          opts.onAwaiting?.()
          return
        }
        if (msg.t === 'denied') return finish({ kind: 'denied' })
        if (msg.t !== 'status') return finish({ kind: 'failed' })
        const session: Session = {
          port,
          send: (m) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(m))
          },
          close: () => ws.close(),
        }
        finish({ kind: 'connected', session })
        phase = 'ready'
        keepalive = setInterval(() => session.send({ t: 'ping' }), opts.keepaliveMs)
        onMessage(msg)
      }
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
