// Settings: a row of tabs, each in its own file.
import { useLayoutEffect, useRef, useState } from 'react'
import type { RecordingView, ShellState } from '../../../../shared/types.ts'
import { Button } from '../../ui/controls.tsx'
import { AiTab } from './AiTab.tsx'
import { AssistantsTab } from './AssistantsTab.tsx'
import { GeneralTab } from './GeneralTab.tsx'
import { RecordingTab } from './RecordingTab.tsx'
import './settings.css'

type Tab = 'recording' | 'general' | 'assistants' | 'ai'

const TABS: { value: Tab; label: string }[] = [
  { value: 'recording', label: 'Recording & privacy' },
  { value: 'general', label: 'General' },
  { value: 'assistants', label: 'Assistants' },
  { value: 'ai', label: 'AI' },
]

export function Settings({ shell, rec }: { shell: ShellState | null; rec: RecordingView | null }) {
  const [tab, setTab] = useState<Tab>('recording')
  const [done, setDone] = useState<string | null>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const [line, setLine] = useState<{ left: number; width: number } | null>(null)
  // The underline slides to the chosen tab, measured from the tab itself so any label length fits.
  useLayoutEffect(() => {
    const el = tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (el) setLine({ left: el.offsetLeft, width: el.offsetWidth })
  }, [tab])
  return (
    <>
      <div className="header settings-header">
        <div className="settings-tabs" role="tablist" aria-label="Settings" ref={tabs}>
          {line && <span className="settings-tab-line" style={{ transform: `translateX(${line.left}px)`, width: line.width }} />}
          {TABS.map((t) => (
            <button
              type="button"
              key={t.value}
              role="tab"
              aria-selected={t.value === tab}
              onClick={() => {
                setDone(null)
                setTab(t.value)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll">
        <div className="settings-stack" key={done === null ? tab : 'done'}>
          {done !== null ? (
            <div className="settings-row">
              <span className="grow">{done}</span>
              <Button onClick={() => setDone(null)}>Done</Button>
            </div>
          ) : (
            <>
              {tab === 'recording' && <RecordingTab shell={shell} rec={rec} onDeleted={setDone} />}
              {tab === 'general' && <GeneralTab shell={shell} />}
              {tab === 'assistants' && <AssistantsTab />}
              {tab === 'ai' && <AiTab />}
            </>
          )}
        </div>
      </div>
    </>
  )
}
