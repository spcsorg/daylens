// Settings › AI: the person's own Anthropic key, which writes their hours and answers Ask.
import { useEffect, useState } from 'react'
import type { AiStatus } from '../../../../shared/ai.ts'
import { act } from '../../lib/api.ts'
import { Button } from '../../ui/controls.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { Row } from './Row.tsx'
import './ai.css'

// Settings › Recording & privacy shows this.
export const WHAT_GOES_TO_AI =
  'When you ask a question, only the parts of your record it needs. When an hour is written, that hour’s apps, window and page titles, and times. Your record stays on this computer.'

const KEYS_URL = 'https://console.anthropic.com/settings/keys'

/** Paste a key, check it with Anthropic, save it. Used here, in Ask and in onboarding. */
export function KeyForm({ onSaved, autoFocus }: { onSaved: () => void; autoFocus?: boolean }) {
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="key-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setChecking(true)
        setError(null)
        const r = await act({ a: 'ai_key_save', key })
        setChecking(false)
        if (!r.ok) return setError(r.error)
        setKey('')
        onSaved()
      }}
    >
      <div className="key-form-row">
        <input
          className="field grow"
          type="password"
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={key}
          onChange={(e) => (setKey(e.target.value), setError(null))}
        />
        <Button kind="primary" size="regular" type="submit" disabled={!key.trim() || checking}>
          {checking ? <Icon name="spinner" className="spin" /> : 'Save'}
        </Button>
      </div>
      {error ? (
        <span className="key-form-note error" role="alert">
          {error}
        </span>
      ) : (
        <span className="key-form-note">
          Get one in the{' '}
          <button type="button" className="link" onClick={() => void act({ a: 'open_url', url: KEYS_URL })}>
            Anthropic Console
          </button>
          . It’s kept encrypted on this computer.
        </span>
      )}
    </form>
  )
}

export function AiTab() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const load = () =>
    void act({ a: 'ai_status' }).then((r) => {
      if (r.ok) setStatus(r.result as AiStatus)
      else setProblem(r.error)
    })
  useEffect(load, [])

  // A saved key that can't be read is entered again here.
  if (problem)
    return (
      <div className="settings-row settings-key">
        <p className="settings-problem">{problem}</p>
        <KeyForm onSaved={() => (setProblem(null), load())} />
      </div>
    )
  if (!status) return null
  return (
    <div className="settings-group">
      {status.saved ? (
        <Row label="Anthropic API key" detail={note ?? 'Saved. Claude Opus 5.5 writes your hours and Claude Sonnet 5.5 answers Ask.'}>
          <div className="settings-actions">
            <Button
              disabled={testing}
              onClick={async () => {
                setTesting(true)
                const r = await act({ a: 'ai_key_test' })
                setTesting(false)
                setNote(r.ok ? 'Anthropic accepted the key.' : r.error)
              }}
            >
              {testing ? 'Testing…' : 'Test'}
            </Button>
            <Button
              kind="quiet"
              onClick={async () => {
                await act({ a: 'ai_key_clear' })
                setNote(null)
                load()
              }}
            >
              Remove
            </Button>
          </div>
        </Row>
      ) : (
        <div className="settings-row settings-key">
          <div className="settings-row-text">
            <span className="settings-row-label">Anthropic API key</span>
            <span className="settings-row-detail">With your key, Claude writes each hour and answers Ask. Without one, hours show what Daylens recorded and nothing is sent.</span>
          </div>
          <KeyForm onSaved={load} />
        </div>
      )}
    </div>
  )
}
