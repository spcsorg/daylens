import { useEffect, useState } from 'react'
import type { AiStatus } from '../../../../shared/ai.ts'
import type { ShellState } from '../../../../shared/types.ts'
import { act, bridge, useQuery } from '../../lib/api.ts'
import { dateKey, factsTitle, hourLabel, longDay } from '../../lib/format.ts'
import { Button } from '../../ui/controls.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { AppIcon } from '../../ui/records.tsx'
import { errorText } from '../../ui/status.tsx'
import { KeyForm } from '../settings/AiTab.tsx'
import './onboarding.css'

function StatusIcon({ state }: { state: 'waiting' | 'allowed' | 'off' }) {
  if (state === 'allowed')
    return (
      <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="var(--ok)" />
        <path d="M6 10.2l2.6 2.6L14 7.4" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (state === 'off')
    return (
      <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.25" stroke="var(--text-2)" strokeWidth="1.5" fill="none" />
        <path d="M6.5 10h7" stroke="var(--text-2)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  return (
    <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="2.5 2.5" fill="none" />
    </svg>
  )
}

/** Window-title permission, then the user's own hours so far, then Today. */
export function Onboarding({ shell, onDone }: { shell: ShellState | null; onDone: () => void }) {
  const [step, setStep] = useState<'permission' | 'morning'>('permission')
  const [visited, setVisited] = useState(false)
  const allowed = shell?.helper.accessibility === 'granted'
  const notApplicable = shell?.helper.accessibility === 'not_applicable'
  const toast = useToast()
  useEffect(() => {
    if (notApplicable) setStep('morning')
  }, [notApplicable])
  // The drag tile closes once access arrives; it turns green by itself.
  useEffect(() => {
    if (allowed) setVisited(false)
  }, [allowed])
  if (step === 'morning') return <Morning onBack={notApplicable ? undefined : () => setStep('permission')} onDone={onDone} />
  const openSettings = async () => {
    const r = await act({ a: 'open_settings_privacy' })
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    setVisited(true)
  }
  const rowState = allowed ? 'allowed' : visited || shell?.helper.accessibility !== 'denied' ? 'waiting' : 'off'
  return (
    <div className="onboarding">
      <div className="onboarding-col">
        <h1>Let Daylens see your windows</h1>
        <p className="lead">Daylens is noting which app is in front. Allow window titles so it can note what you had open in it, too.</p>
        <div className="ob-card">
          <div className="ob-row">
            <StatusIcon state={rowState} />
            <div className="ob-row-text">
              <span className="ob-label">Windows and their titles</span>
              <span className="ob-detail">{allowed ? 'Allowed' : visited ? 'Turn on Daylens in the list' : shell?.helper.running ? 'Waiting for you' : 'Starting'}</span>
            </div>
          </div>
        </div>
        <p className="ob-detail">Pause or delete any time from the menu bar.</p>
        <div className="ob-actions">
          {allowed ? (
            <Button kind="primary" size="regular" onClick={() => setStep('morning')}>
              Continue
            </Button>
          ) : (
            <>
              <Button kind="primary" size="regular" onClick={() => void openSettings()}>
                Open System Settings
              </Button>
              {visited && (
                <Button size="regular" onClick={() => setStep('morning')}>
                  Continue without
                </Button>
              )}
            </>
          )}
        </div>
        {visited && !allowed && <p className="ob-detail">Without it, Daylens still sees which app is in front, but not its windows.</p>}
      </div>
      {visited && !allowed && (
        <div className="drag-tile" draggable onDragStart={(e) => (e.preventDefault(), void bridge.action({ a: 'drag_helper' }))}>
          <img src="./app-icon.png" width={36} height={36} alt="" draggable={false} />
          <div className="ob-row-text">
            <span className="ob-label">Drag Daylens into the list</span>
            <span className="ob-detail">This turns green by itself.</span>
          </div>
        </div>
      )}
    </div>
  )
}

function Morning({ onBack, onDone }: { onBack?: () => void; onDone: () => void }) {
  const today = dateKey(new Date())
  const { data } = useQuery({ q: 'day', date: today }, { live: true })
  const hours = data?.hours ?? []
  const [keySaved, setKeySaved] = useState(false)
  useEffect(() => void act({ a: 'ai_status' }).then((r) => r.ok && setKeySaved((r.result as AiStatus).saved)), [])
  return (
    <div className="onboarding">
      <div className="onboarding-col">
        {onBack && (
          <Button kind="quiet" className="ob-back" onClick={onBack}>
            <Icon name="chevron-left" /> Back
          </Button>
        )}
        <div>
          <h1>Your day so far</h1>
          <div className="ob-date">{longDay(today)}</div>
        </div>
        <div>
          {hours.map((h) => (
            <div className="morning-row" key={h.start_ms}>
              <span className="time">{hourLabel(h.start_ms)}</span>
              <span className="names">{h.gap ? 'Nothing recorded' : factsTitle(h) || 'Recording now'}</span>
              {h.from_history && <span className="ob-detail">From browser history</span>}
              <span className="ob-icons">
                {h.facts.apps.slice(0, 4).map((a) => (
                  <AppIcon key={a.id} id={a.id} size={16} />
                ))}
              </span>
            </div>
          ))}
        </div>
        <p className="ob-detail">
          {hours.some((h) => h.from_history)
            ? 'Earlier hours come from your browser history: the pages you opened, with less detail.'
            : hours.length > 1
              ? 'From what Daylens recorded since you opened it.'
              : 'Hours appear here from now on.'}
        </p>
        <div className="ob-card">
          <div className="ob-row ob-stack">
            <span className="ob-label">Write these hours with Claude</span>
            {keySaved ? (
              <span className="ob-detail">Saved. Claude writes each hour a few minutes after it ends, and answers Ask.</span>
            ) : (
              <>
                <span className="ob-detail">Add your Anthropic API key, or skip it: hours then show what Daylens recorded, and nothing is sent.</span>
                <KeyForm onSaved={() => setKeySaved(true)} />
              </>
            )}
          </div>
        </div>
        <div>
          <Button
            kind="primary"
            size="regular"
            onClick={async () => {
              await act({ a: 'onboarded' })
              onDone()
            }}
          >
            Open Today
          </Button>
        </div>
      </div>
    </div>
  )
}
