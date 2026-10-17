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

// An archived Codex log compressed with zstd is immutable: it is read once, whole.
export async function readCompressed(file: string, sink: LineSink, checkpoint: () => void): Promise<number> {
  const splitter = new Splitter(sink, false)
  let bytes = 0
  const input = createReadStream(file)
  const z = zlib.createZstdDecompress()
  try {
    await new Promise<void>((resolve, reject) => {
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
  } finally {
    // A decompressor's native state is freed by the garbage collector only when it gets round to it; dozens of small
    // archives in a row would otherwise hold dozens of them at once.
    input.destroy()
    z.close()
  }
  splitter.push(Buffer.from('\n'))
  return bytes
}
