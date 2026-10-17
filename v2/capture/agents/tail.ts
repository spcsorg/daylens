// Reads only the bytes appended to a log since the last read, one complete line at a time.
// Memory stays bounded: a line too long to keep is passed on as its head and tail only.

import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import zlib from 'node:zlib'

const CHUNK = 1 << 20
const EDGE = 8192
// Pasted images and large tool records make lines of many megabytes. Decoding them would hold that much memory for
// fields that sit at the line's edges, so past this size only the head and tail are kept.
export const MAX_LINE = 1 << 20

export type LineSink = (text: string | null, head: string, tail: string) => void

class Splitter {
  private parts: Buffer[] = []
  private size = 0
  private head: Buffer | null = null
  private tail: Buffer = Buffer.alloc(0)
  consumed = 0
  committed = 0
  private readonly sink: LineSink

  constructor(sink: LineSink) {
    this.sink = sink
  }

  push(buf: Buffer): void {
    let start = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, start)
      if (nl === -1) {
        // The caller reuses its read buffer, so a line that continues into the next read is copied out first.
        this.keep(Buffer.from(buf.subarray(start)))
        break
      }
      this.keep(buf.subarray(start, nl))
      this.emit()
      this.committed = this.consumed + nl + 1
      start = nl + 1
    }
    this.consumed += buf.length
  }

  private keep(b: Buffer): void {
    if (b.length === 0) return
    if (this.head === null && this.size + b.length <= MAX_LINE) {
      this.parts.push(b)
      this.size += b.length
      return
    }
    if (this.head === null) {
      const whole = Buffer.concat(this.parts)
      this.head = Buffer.from(whole.subarray(0, EDGE))
      this.tail = Buffer.from(whole.subarray(Math.max(0, whole.length - EDGE)))
      this.parts = []
      this.size = 0
    }
    const joined = Buffer.concat([this.tail, b])
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - EDGE)))
  }

  private emit(): void {
    if (this.head !== null) {
      this.sink(null, this.head.toString('utf8'), this.tail.toString('utf8'))
      this.head = null
      this.tail = Buffer.alloc(0)
      return
    }
    if (this.size === 0) return
    let text = (this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)).toString('utf8')
    this.parts = []
    this.size = 0
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (text.length === 0) return
    this.sink(text, text.length > EDGE ? text.slice(0, EDGE) : text, text.length > EDGE ? text.slice(-EDGE) : text)
  }
}

// Reads normally run one at a time, so one buffer is kept for the next one.
let spare: Buffer | null = null

export interface ReadResult {
  // Byte offset just past the last complete line read; a partial last line is read again next time.
  next: number
  bytes: number
}

// `checkpoint` runs between lines at chunk boundaries with the offset of the last complete line, so a caller can
// store progress together with the parser state that belongs to exactly that offset.
export async function readAppended(file: string, from: number, size: number, sink: LineSink, checkpoint: (offset: number) => void): Promise<ReadResult> {
  const fh = await open(file, 'r')
  try {
    const splitter = new Splitter(sink)
    const buf = spare ?? Buffer.allocUnsafe(CHUNK)
    spare = null
    let pos = from
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos)
      if (bytesRead === 0) break
      splitter.push(buf.subarray(0, bytesRead))
      pos += bytesRead
      checkpoint(from + splitter.committed)
    }
    spare = buf
    return { next: from + splitter.committed, bytes: pos - from }
  } finally {
    await fh.close()
  }
}

// An archived Codex log compressed with zstd is immutable: it is read once, whole.
export async function readCompressed(file: string, sink: LineSink, checkpoint: () => void): Promise<number> {
  const splitter = new Splitter(sink)
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file)
    const z = zlib.createZstdDecompress()
    input.on('error', reject)
    z.on('error', reject)
    z.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      splitter.push(chunk)
      checkpoint()
    })
    z.on('end', () => resolve())
    input.pipe(z)
  })
  splitter.push(Buffer.from('\n'))
  return bytes
}
