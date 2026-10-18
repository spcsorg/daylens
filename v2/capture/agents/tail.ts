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

// `text` decodes the whole line; it is valid only while the sink runs, since the bytes behind it are reused.
export type LineSink = (text: (() => string | null) | null, head: string, tail: string) => void

class Splitter {
  private parts: Buffer[] = []
  private size = 0
  private head: Buffer | null = null
  private tail: Buffer = Buffer.alloc(0)
  consumed = 0
  committed = 0
  private readonly sink: LineSink
  // Whether the caller reuses each buffer it pushes, so a line continuing past it must be copied out.
  private readonly reused: boolean

  constructor(sink: LineSink, reused: boolean) {
    this.sink = sink
    this.reused = reused
  }

  push(buf: Buffer): void {
    let start = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, start)
      if (nl === -1) {
        this.keep(this.reused ? Buffer.from(buf.subarray(start)) : buf.subarray(start))
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
    if (b.length >= EDGE) this.tail = Buffer.from(b.subarray(-EDGE))
    else {
      const joined = Buffer.concat([this.tail, b])
      this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - EDGE)))
    }
  }

  private emit(): void {
    if (this.head !== null) {
      this.sink(null, this.head.toString('utf8'), this.tail.toString('utf8'))
      this.head = null
      this.tail = Buffer.alloc(0)
      return
    }
    if (this.size === 0) return
    // Most bytes in these logs are tool output and bulk records that parsers classify from a line's first bytes, so a
    // line is decoded whole only when a parser asks for it.
    let line = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)
    this.parts = []
    this.size = 0
    if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
    if (line.length === 0) return
    const head = line.subarray(0, EDGE).toString('utf8')
    const tail = line.length > EDGE ? line.subarray(-EDGE).toString('utf8') : head
    this.sink(() => line.toString('utf8'), head, tail)
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
export async function readAppended(file: string, from: number, size: number, sink: LineSink, checkpoint: (offset: number) => void, budget = Infinity): Promise<ReadResult> {
  const fh = await open(file, 'r')
  try {
    const splitter = new Splitter(sink, true)
    const buf = spare ?? Buffer.allocUnsafe(CHUNK)
    spare = null
    let pos = from
    while (pos < size) {
      const left = budget - (pos - from)
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos, left > 0 ? left : CHUNK), pos)
      if (bytesRead === 0) break
      splitter.push(buf.subarray(0, bytesRead))
      pos += bytesRead
      checkpoint(from + splitter.committed)
      // An oversized first line must finish before a slice can save progress.
      if (pos - from >= budget && splitter.committed > 0) break
    }
    spare = buf
    return { next: from + splitter.committed, bytes: pos - from }
  } finally {
    await fh.close()
  }
}

class StreamTail {
  private readonly input: ReturnType<typeof createReadStream>
  private readonly decoder: ReturnType<typeof zlib.createZstdDecompress> | null
  private readonly from: number
  private readonly size: number | undefined
  private readonly chunks: AsyncIterator<Buffer>
  private readonly splitter: Splitter
  private sink: LineSink = () => {}
  private pending: Buffer = Buffer.alloc(0)
  private ended = false

  constructor(file: string, compressed: boolean, from = 0, size?: number) {
    this.from = from
    this.size = size
    this.input = createReadStream(file, compressed ? {} : { start: from, end: size === undefined ? undefined : size - 1, highWaterMark: CHUNK })
    this.decoder = compressed ? zlib.createZstdDecompress() : null
    if (this.decoder) {
      const decoder = this.decoder
      this.input.on('error', (err) => decoder.destroy(err))
    }
    this.chunks = (this.decoder ? this.input.pipe(this.decoder) : this.input)[Symbol.asyncIterator]()
    this.splitter = new Splitter((text, head, tail) => this.sink(text, head, tail), false)
  }

  async read(sink: LineSink, checkpoint: (offset: number) => void, budget = Infinity): Promise<{ bytes: number; next: number; done: boolean }> {
    this.sink = sink
    let bytes = 0
    try {
      while (!this.ended && bytes < budget) {
        if (this.pending.length === 0) {
          const chunk = await this.chunks.next()
          if (chunk.done) {
            this.ended = true
            if (this.decoder) this.splitter.push(Buffer.from('\n'))
            break
          }
          this.pending = chunk.value
        }
        const length = Math.min(this.pending.length, budget - bytes)
        this.splitter.push(this.pending.subarray(0, length))
        this.pending = this.pending.subarray(length)
        bytes += length
        checkpoint(this.from + this.splitter.committed)
        if (this.size !== undefined && this.from + this.splitter.consumed >= this.size) this.ended = true
      }
      return { bytes, next: this.from + this.splitter.committed, done: this.ended }
    } finally {
      this.sink = () => {}
      if (this.ended) this.close()
    }
  }

  close(): void {
    this.input.destroy()
    this.decoder?.close()
  }
}

export class CompressedTail extends StreamTail {
  constructor(file: string) { super(file, true) }
}

export class AppendedTail extends StreamTail {
  constructor(file: string, from: number, size: number) { super(file, false, from, size) }
}

export async function readCompressed(file: string, sink: LineSink, checkpoint: () => void): Promise<number> {
  const stream = new CompressedTail(file)
  try {
    return (await stream.read(sink, checkpoint)).bytes
  } finally {
    stream.close()
  }
}
