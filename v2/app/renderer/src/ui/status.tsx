import type { ReactNode } from 'react'
import type { RecordingView, ShellState } from '../../../shared/types.ts'
import { act } from '../lib/api.ts'
import { clock, dateKey } from '../lib/format.ts'
import { Icon } from './Icon.tsx'
import { useToast } from './overlays.tsx'

export function errorText(code: string): string {
  switch (code) {
    case 'capture_stopped':
      return 'Daylens isn’t recording right now, so that couldn’t be saved. Restart recording and try again.'
    case 'timeout':
      return 'Daylens didn’t answer in time. Try again.'
    case 'app_not_found':
      return 'That app isn’t on this computer anymore.'
    case 'not_an_app':
      return 'That isn’t an app Daylens can keep out. Choose one from Applications.'
    case 'login_item_refused':
      return 'macOS didn’t allow that. Change it in System Settings › General › Login Items.'
    default:
      return 'That didn’t work. Try again.'
  }
}

function Notice({ kind, text, action, onAction }: { kind: 'paused' | 'problem'; text: string; action?: string; onAction?: () => void }) {
  return (
    <div className={`notice ${kind}`} role="status">
      <Icon name={kind === 'paused' ? 'pause' : 'alert'} />
      <span className="grow">{text}</span>
      {action && (
        <button type="button" className="notice-action" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  )
}

export function pauseText(p: { until_ms: number | null }): string {
  if (p.until_ms === null) return 'Paused until you resume.'
  const d = new Date(p.until_ms)
  if (d.getHours() === 0 && d.getMinutes() === 0 && dateKey(d) !== dateKey(new Date())) return 'Paused until tomorrow.'
  return `Paused until ${clock(p.until_ms)}.`
}

type RecordingState = 'stopped' | 'paused' | 'no_titles' | 'ok'

export function recordingState(shell: ShellState | null, rec: RecordingView | null): RecordingState {
  if (shell && (shell.capture === 'failed' || shell.capture_error === 'another_writer')) return 'stopped'
  if (rec?.stopped_since_ms) return 'stopped'
  if (rec?.pause) return 'paused'
  if (shell?.helper.accessibility === 'denied' || rec?.titles === 'no_permission') return 'no_titles'
  return 'ok'
}

/** Recording status shows only when Daylens is paused or something is wrong. */
export function StatusNotice({ shell, rec }: { shell: ShellState | null; rec: RecordingView | null }) {
  const toast = useToast()
  const state = recordingState(shell, rec)
  const run = async (a: Parameters<typeof act>[0]) => {
    const r = await act(a)
    if (!r.ok) toast({ text: errorText(r.error), error: true })
  }
  if (state === 'stopped') {
    const since = rec?.stopped_since_ms
    const text = shell?.capture_error === 'another_writer' ? 'Another copy of Daylens is recording, so this one isn’t.' : since ? `Daylens stopped recording at ${clock(since)}.` : 'Daylens stopped recording.'
    return <Notice kind="problem" text={text} action="Restart" onAction={() => void run({ a: 'restart_capture' })} />
  }
  if (state === 'paused' && rec?.pause) return <Notice kind="paused" text={`${pauseText(rec.pause)} Nothing is recorded.`} action="Resume" onAction={() => void run({ a: 'resume' })} />
  if (state === 'no_titles') return <Notice kind="problem" text="Window titles are off, so Daylens sees which app is in front but not its windows." action="Allow" onAction={() => void run({ a: 'open_settings_privacy' })} />
  return null
}
