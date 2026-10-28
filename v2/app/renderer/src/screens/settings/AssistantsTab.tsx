// Settings › Assistants: the MCP apps on this computer, each connected in one click; setup for any other app; and
// what assistants read and asked to change.
import { useEffect, useState } from 'react'
import { describeRequest, type RequestState } from '../../../../../storage/assistantRequests.ts'
import type { AssistantApp, AssistantAppState, ReadEntry } from '../../../../shared/assistants.ts'
import { act, useQuery } from '../../lib/api.ts'
import { dateKey, plainDay, rangeTitle, seenAt, span } from '../../lib/format.ts'
import { Button } from '../../ui/controls.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { AppIcon } from '../../ui/records.tsx'
import { errorText } from '../../ui/status.tsx'
import { Row } from './Row.tsx'

// The app's own icon; command-line assistants show the terminal they run in.
const ICONS: Record<string, string> = {
  'claude': 'com.anthropic.claudefordesktop',
  'claude-code': 'com.apple.Terminal',
  'codex': 'com.openai.codex',
  'cursor': 'com.todesktop.230313mzl4w4u92',
  'vscode': 'com.microsoft.VSCode',
  'windsurf': 'com.exafunction.windsurf',
  'gemini': 'com.apple.Terminal',
}

const STATE: Record<AssistantAppState, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  other_server: 'Starts another Daylens server',
  unreadable: 'Its settings file can’t be read, so Daylens leaves it alone',
}

const OUTCOME: Record<RequestState, string> = {
  pending: 'waiting for you',
  running: 'running',
  done: 'done',
  declined: 'you said no',
  failed: 'failed',
  expired: 'lapsed',
}

function days(r: ReadEntry): string {
  const from = dateKey(new Date(r.from_wall_ms))
  const to = dateKey(new Date(r.to_wall_ms - 1))
  return from === to ? plainDay(from) : rangeTitle(from, to)
}

function readText(r: ReadEntry): string {
  switch (r.tool) {
    case 'search':
      return `Searched for “${r.query ?? ''}”`
    case 'get_hour':
      return `Read ${plainDay(dateKey(new Date(r.from_wall_ms)))}, ${span(r.from_wall_ms, r.to_wall_ms)}`
    case 'get_agent_work':
      return `Read agent work, ${days(r)}`
    case 'get_apps':
      return `Read time per app, ${days(r)}`
    case 'get_status':
      return 'Read recording status'
    default:
      return `Read ${days(r)}`
  }
}

export function AssistantsTab() {
  const [apps, setApps] = useState<AssistantApp[] | null>(null)
  const [test, setTest] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: log } = useQuery({ q: 'assistant_log' })
  const toast = useToast()

  useEffect(() => {
    void act({ a: 'assistant_apps' }).then((r) => r.ok && setApps(r.result as AssistantApp[]))
  }, [])

  const toggle = async (app: AssistantApp) => {
    const on = app.state !== 'connected'
    const r = await act({ a: 'assistant_connect', id: app.id, on })
    if (!r.ok) return toast({ text: errorText(r.error), error: true })
    setApps(r.result as AssistantApp[])
    toast({ text: on ? `Connected. Restart ${app.name} to use Daylens.` : `Disconnected from ${app.name}.` })
  }
  const runTest = async () => {
    setBusy(true)
    const r = await act({ a: 'assistant_test' })
    setBusy(false)
    setTest(r.ok ? `Works. Assistants can use ${(r.result as string[]).length} tools.` : `Didn’t start: ${r.error}`)
  }
  const copy = async () => {
    const r = await act({ a: 'assistant_copy_setup' })
    toast(r.ok ? { text: 'Copied. Paste it into the app’s MCP settings.' } : { text: errorText(r.error), error: true })
  }

  const entries = [
    ...(log?.reads ?? []).map((r) => ({ key: `r${r.id}`, at: r.at_wall_ms, who: r.assistant, text: readText(r) })),
    ...(log?.requests ?? []).map((r) => ({ key: `q${r.id}`, at: r.at_wall_ms, who: r.assistant, text: `Asked to ${describeRequest(r.change).replace(/^./, (c) => c.toLowerCase())} · ${OUTCOME[r.state]}` })),
  ].sort((a, b) => b.at - a.at)

  return (
    <>
      <div className="settings-group">
        {apps?.length === 0 && <Row label="No assistant apps found" detail="Claude, Claude Code, Codex, Cursor, VS Code, Windsurf and Gemini CLI connect here once installed." />}
        {apps?.map((app) => (
          <div className="settings-row" key={app.id}>
            <AppIcon id={ICONS[app.id] ?? null} size={28} />
            <div className="settings-row-text">
              <span className="settings-row-label">{app.name}</span>
              <span className="settings-row-detail">{STATE[app.state]}</span>
            </div>
            {app.state !== 'unreadable' && (
              <Button kind={app.state === 'connected' ? 'quiet' : 'secondary'} onClick={() => void toggle(app)}>
                {app.state === 'connected' ? 'Disconnect' : 'Connect'}
              </Button>
            )}
          </div>
        ))}
        <Row label="Another app" detail="Copy the setup and paste it into the app’s MCP settings.">
          <Button onClick={() => void copy()}>Copy setup</Button>
        </Row>
        <Row label="Daylens’s server" detail={test ?? 'Test starts it the way an assistant does.'}>
          <Button onClick={() => void runTest()} disabled={busy}>
            Test
          </Button>
        </Row>
      </div>
      {entries.length > 0 && (
        <div>
          <h2 className="settings-heading">Recent</h2>
          <div className="settings-card">
            {entries.slice(0, 50).map((e) => (
              <Row key={e.key} label={e.text} detail={`${e.who} · ${seenAt(e.at)}`} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
