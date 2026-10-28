// The search index's structure record (FTS5's %_data row 10): its levels and segments, as FTS5 itself reads it
// (fts5StructureDecode in sqlite3.c). Integers are SQLite varints.
import type Database from 'better-sqlite3'

export interface FtsSegment {
  id: number
  pgnoFirst: number
  pgnoLast: number
}

export interface FtsLevel {
  // The first nMerge segments are inputs to a merge in progress, whose output is the last segment of the next level.
  nMerge: number
  segments: FtsSegment[]
}

export interface FtsStructure {
  levels: FtsLevel[]
}

const STRUCTURE_ROWID = 10
const STRUCTURE_V2 = Buffer.from([0xff, 0x00, 0x00, 0x01])
// A segment's leaves are rows (segment id << 37) + page number of %_data.
export const SEGMENT_SHIFT = 37

function varint(b: Buffer, at: { i: number }): number {
  let v = 0n
  for (let n = 0; n < 9; n++) {
    if (at.i >= b.length) throw new Error('search index structure record is truncated')
    const byte = b[at.i++]!
    if (n === 8) {
      v = (v << 8n) | BigInt(byte)
      break
    }
    v = (v << 7n) | BigInt(byte & 0x7f)
    if ((byte & 0x80) === 0) break
  }
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('search index structure record holds an out-of-range value')
  return Number(v)
}

export function decodeStructure(b: Buffer): FtsStructure {
  const at = { i: 4 }
  const v2 = b.subarray(4, 8).equals(STRUCTURE_V2)
  if (v2) at.i = 8
  const nLevel = varint(b, at)
  let nSegment = varint(b, at)
  varint(b, at)
  const levels: FtsLevel[] = []
  for (let l = 0; l < nLevel; l++) {
    const nMerge = varint(b, at)
    const nSeg = varint(b, at)
    if (nMerge > nSeg) throw new Error('search index structure record is inconsistent')
    const segments: FtsSegment[] = []
    for (let s = 0; s < nSeg; s++) {
      segments.push({ id: varint(b, at), pgnoFirst: varint(b, at), pgnoLast: varint(b, at) })
      if (v2) for (let k = 0; k < 5; k++) varint(b, at)
    }
    nSegment -= nSeg
    levels.push({ nMerge, segments })
  }
  if (nSegment !== 0) throw new Error('search index structure record is inconsistent')
  return { levels }
}

/** The structure as committed; null before the index has one. */
export function readStructure(db: Database.Database): FtsStructure | null {
  const row = db.prepare(`SELECT block FROM search_data WHERE id = ${STRUCTURE_ROWID}`).pluck().get() as Buffer | undefined
  return row === undefined ? null : decodeStructure(row)
}

export function segmentCount(s: FtsStructure): number {
  return s.levels.reduce((n, l) => n + l.segments.length, 0)
}

export function leafRowid(segment: number, page: number): number {
  return segment * 2 ** SEGMENT_SHIFT + page
}
