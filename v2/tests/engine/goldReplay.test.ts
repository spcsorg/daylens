import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { replayGoldDay } from '../../tools/goldReplay.ts'
import { tempDir } from '../support/tmp.ts'

const DAY0 = Date.parse('2030-03-05T00:00:00+02:00')
const at = (hhmm: string) => DAY0 + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000

// A synthetic V1 day in the gold folder's layout.
function goldDay(events: { at: string; type: string; app?: string }[]): string {
  const dir = tempDir('daylens-gold-test-')
  const raw = path.join(dir, 'raw')
  mkdirSync(path.join(raw, 'agent-home'), { recursive: true })
  const rows = events.map((e, i) => ({
    id: i + 1,
    ts_ms: at(e.at),
    event_type: e.type,
    source: e.app ? 'nsworkspace_event' : 'capture_supervisor',
    app_bundle_id: e.app ? `com.example.${e.app.toLowerCase()}` : null,
    app_name: e.app ?? null,
    pid: e.app ? 100 + e.app.length : null,
    window_title: e.app ? `${e.app} window` : null,
  }))
  const files: Record<string, string> = {
    'v1-focus_events.jsonl': rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'v1-website_visits.jsonl': '',
    'v1-calendar.jsonl': '',
    'commits.json': '[]',
    'app-identities.json': '{}',
  }
  const manifest: Record<string, string> = {}
  for (const [f, body] of Object.entries(files)) {
    writeFileSync(path.join(raw, f), body)
    manifest[f] = createHash('sha256').update(readFileSync(path.join(raw, f))).digest('hex')
  }
  writeFileSync(path.join(raw, 'MANIFEST.sha256.json'), JSON.stringify(manifest))
  return dir
}

test('replayed idle starts at the last app switch when V1 recorded one after the idle threshold, else a threshold before the notice', async () => {
  const dir = goldDay([
    { at: '08:00', type: 'app_activated', app: 'Editor' },
    { at: '08:05', type: 'app_activated', app: 'Terminal' },
    { at: '08:06', type: 'app_activated', app: 'Editor' },
    { at: '08:07', type: 'idle_started' },
    { at: '08:15', type: 'idle_ended' },
    { at: '08:20', type: 'app_activated', app: 'Terminal' },
    { at: '08:30', type: 'idle_started' },
    { at: '08:40', type: 'idle_ended' },
    { at: '08:59', type: 'app_activated', app: 'Editor' },
  ])
  const r = await replayGoldDay({ goldDir: dir, date: '2030-03-05', tz: 'Africa/Kigali', utcOffsetMin: 120, hours: [8], extensionBrowsers: [], packet: { staleTitleMs: 3_600_000, nearbyHours: 1, openThreadMs: 10_800_000 } })
  r.close()
  const away = r.packets.get(8)!.packet.away.filter((w) => w.why === 'idle').map((w) => [w.from, w.to])
  assert.deepEqual(away, [
    ['08:06', '08:15'],
    ['08:28', '08:40'],
  ])
})
