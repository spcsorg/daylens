import { useEffect, useState } from 'react'
import { describeRequest, REQUEST_TTL_MS, runsWithoutAsking, type RequestChange } from '../../../../../storage/assistantRequests.ts'
import { act, useQuery } from '../../lib/api.ts'
import { Button } from '../../ui/controls.tsx'
import { Dialog, useToast } from '../../ui/overlays.tsx'
import { errorText } from '../../ui/status.tsx'

const ARM_MS = 700

// Changes that delete or can't be taken back get the red button.
const deletes = (c: RequestChange) => c.kind === 'delete' || (c.kind === 'retention' && c.days !== null)

// Esc or a click outside leaves the request waiting: only a button answers, so a stray dismissal never reads as "no".
const stay = () => {}

const failed = (code: string) => (code === 'request_expired' ? 'That request had waited too long, so nothing changed. Ask again if you still want it.' : code === 'request_gone' ? 'That request was already answered.' : errorText(code))

/** A change an assistant asked for, waiting on the person's answer: one at a time, oldest first, over any screen. */
export function AssistantRequests() {
  const { data, refetch } = useQuery({ q: 'assistant_requests' })
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<number | null>(null)
  const toast = useToast()
  const r = data?.find((x) => x.state === 'pending' && !runsWithoutAsking(x.change))
  // A lapsed request leaves the screen when it lapses, not at the next change.
  useEffect(() => {
    if (!r) return
    const t = setTimeout(refetch, Math.max(0, r.at_wall_ms + REQUEST_TTL_MS - Date.now()))
    return () => clearTimeout(t)
  }, [r, refetch])
  // A new card's yes waits a moment, so a click meant for the card before can't answer this one.
  useEffect(() => {
    if (!r) return
    const t = setTimeout(() => setArmed(r.id), ARM_MS)
    return () => clearTimeout(t)
  }, [r?.id])
  if (!r) return null
  const ready = !busy && armed === r.id
  const answer = async (allow: boolean) => {
    setBusy(true)
    const out = await act({ a: 'assistant_request', id: r.id, allow })
    setBusy(false)
    if (!out.ok) toast({ text: failed(out.error), error: true })
    else if (allow) toast({ text: 'Done.' })
  }
  return (
    <Dialog onClose={stay} label={`${r.assistant} asks`}>
      <div>
        {r.assistant} asks: {describeRequest(r.change)}.
      </div>
      <div className="dialog-actions">
        <Button kind={deletes(r.change) ? 'danger' : 'primary'} onClick={() => void answer(true)} disabled={!ready}>
          {deletes(r.change) ? 'Delete' : 'Allow'}
        </Button>
        <Button onClick={() => void answer(false)} disabled={busy} autoFocus>
          Don’t
        </Button>
      </div>
    </Dialog>
  )
}
