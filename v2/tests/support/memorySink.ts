import type { GapDetail, GapPoint, GapReason, GapStart, ObservationRow, Sink } from '../../capture/normalize.ts'

export interface MemRow extends ObservationRow {
  id: number
  last_seen_wall_ms: number
  repeat_count: number
  flags: string[]
}
export interface MemGap extends GapStart {
  id: number
  end: GapPoint | null
}

export class MemorySink implements Sink {
  rows: MemRow[] = []
  gaps: MemGap[] = []
  insertObservation(row: ObservationRow): number {
    const id = this.rows.length + 1
    this.rows.push({ ...row, id, last_seen_wall_ms: row.event_wall_ms, repeat_count: 0, flags: [] })
    return id
  }
  extendObservation(id: number, lastSeenWallMs: number): void {
    const r = this.rows[id - 1]!
    r.last_seen_wall_ms = lastSeenWallMs
    r.repeat_count++
  }
  flagObservation(id: number, flag: 'possibly_stale'): void {
    this.rows[id - 1]!.flags.push(flag)
  }
  openGap(gap: GapStart): number {
    const id = this.gaps.length + 1
    this.gaps.push({ ...gap, id, end: null })
    return id
  }
  updateGap(id: number, patch: { reason?: GapReason; detail?: GapDetail }): void {
    Object.assign(this.gaps[id - 1]!, patch)
  }
  closeGap(id: number, end: GapPoint): void {
    this.gaps[id - 1]!.end = end
  }
}
