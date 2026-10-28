import { useCallback, useEffect, useRef, useState } from 'react'
import type { Action, ActionResult, Query, QueryResult, ReaderEvent, ShellState } from '../../../shared/types.ts'

interface Bridge {
  platform: string
  query(q: Query): Promise<unknown>
  onReader(fn: (e: ReaderEvent) => void): () => void
  action(a: Action): Promise<ActionResult>
  shell(): Promise<ShellState>
  onShell(fn: (s: ShellState) => void): () => void
  onNavigate(fn: (to: string) => void): () => void
  onDeletionFailed(fn: () => void): () => void
}

declare global {
  interface Window {
    daylens: Bridge
  }
}

export const bridge = window.daylens

export function query<K extends Query['q']>(q: Extract<Query, { q: K }>): Promise<QueryResult[K]> {
  return bridge.query(q) as Promise<QueryResult[K]>
}

export const act = (a: Action) => bridge.action(a)

/**
 * A query that refetches when the record changes. `live` also refetches on new activity (screens that show today).
 * Keeps the last result while a new one loads, so switching never flashes empty.
 */
export function useQuery<K extends Query['q']>(q: Extract<Query, { q: K }> | null, opts: { live?: boolean } = {}): { data: QueryResult[K] | null; error: string | null; refetch: () => void; current: boolean } {
  const [data, setData] = useState<QueryResult[K] | null>(null)
  const [answered, setAnswered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = q ? JSON.stringify(q) : null
  const seq = useRef(0)
  const run = useCallback(() => {
    if (!key) return
    const n = ++seq.current
    query(JSON.parse(key) as Extract<Query, { q: K }>).then(
      (r) => {
        if (n !== seq.current) return
        setData(r)
        setAnswered(key)
        setError(null)
      },
      (err: Error) => {
        if (n === seq.current) setError(err.message)
      },
    )
  }, [key])
  useEffect(run, [run])
  // A hidden window does no work: it notes that it is out of date and catches up when shown.
  const stale = useRef(false)
  useEffect(() => {
    const off = bridge.onReader((e) => {
      if (e.e !== 'changed' && !opts.live) return
      if (document.hidden) stale.current = true
      else run()
    })
    const onVisible = () => {
      if (document.hidden || !stale.current) return
      stale.current = false
      run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      off()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [run, opts.live])
  return { data, error, refetch: run, current: answered === key }
}

export function useShell(): ShellState | null {
  const [s, setS] = useState<ShellState | null>(null)
  useEffect(() => {
    void bridge.shell().then(setS)
    return bridge.onShell(setS)
  }, [])
  return s
}
