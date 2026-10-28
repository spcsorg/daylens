// The server half of RFC 6455, only as much as the extension uses: unfragmented text messages, ping, pong and close.
// No extensions are negotiated, so a frame with any RSV bit set, a binary or fragmented message, an unmasked client
// frame or one over the size limit is a protocol error and ends the connection.

import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const KEY_RE = /^[A-Za-z0-9+/]{22}==$/

export const OP_TEXT = 0x1
export const OP_CLOSE = 0x8
export const OP_PING = 0x9
export const OP_PONG = 0xa

export function acceptKey(key: string): string | null {
  if (!KEY_RE.test(key)) return null
  return createHash('sha1').update(key + GUID).digest('base64')
}

export type Frame = { op: typeof OP_TEXT; text: string } | { op: typeof OP_PING | typeof OP_PONG; data: Buffer } | { op: typeof OP_CLOSE; code: number | null }

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private readonly maxPayload: number
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  failed: string | null = null

  constructor(maxPayload: number) {
    this.maxPayload = maxPayload
  }

  // Frames complete so far. After a protocol error, `failed` says why and nothing more is decoded.
  feed(chunk: Buffer): Frame[] {
    if (this.failed) return []
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: Frame[] = []
    for (;;) {
      const f = this.next()
      if (f === null || this.failed) return out
      out.push(f)
    }
  }

  private fail(why: string): null {
    this.failed = why
    this.buf = Buffer.alloc(0)
    return null
  }

  private next(): Frame | null {
    const b = this.buf
    if (b.length < 2) return null
    const b0 = b[0]!
    const b1 = b[1]!
    const fin = (b0 & 0x80) !== 0
    if ((b0 & 0x70) !== 0) return this.fail('rsv')
    const op = b0 & 0x0f
    if ((b1 & 0x80) === 0) return this.fail('unmasked')
    let len = b1 & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(this.maxPayload)) return this.fail('too_long')
      len = Number(big)
      off = 10
    }
    const control = op >= 0x8
    if (control && (len > 125 || !fin)) return this.fail('bad_control')
    if (!control && !fin) return this.fail('fragmented')
    if (op !== OP_TEXT && op !== OP_CLOSE && op !== OP_PING && op !== OP_PONG) return this.fail('opcode')
    if (len > this.maxPayload) return this.fail('too_long')
    if (b.length < off + 4 + len) return null
    const mask = b.subarray(off, off + 4)
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len))
    for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i & 3]!
    this.buf = b.subarray(off + 4 + len)
    if (op === OP_TEXT) {
      try {
        return { op, text: this.utf8.decode(data) }
      } catch {
        return this.fail('not_utf8')
      }
    }
    if (op === OP_CLOSE) return { op, code: data.length >= 2 ? data.readUInt16BE(0) : null }
    return { op: op as typeof OP_PING | typeof OP_PONG, data }
  }
}

export function encodeFrame(op: number, payload: Buffer): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff]) : null
  if (head) return Buffer.concat([head, payload])
  const h = Buffer.alloc(10)
  h[0] = 0x80 | op
  h[1] = 127
  h.writeBigUInt64BE(BigInt(n), 2)
  return Buffer.concat([h, payload])
}

export function encodeText(text: string): Buffer {
  return encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'))
}

export function encodeClose(code: number): Buffer {
  const p = Buffer.alloc(2)
  p.writeUInt16BE(code, 0)
  return encodeFrame(OP_CLOSE, p)
}
