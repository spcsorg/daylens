// A gold day replayed from its frozen raw records. Gold data is personal and stays outside the repository: GOLD_DIR
// names its folder, and checks about the day itself live there, in checks.gold.ts, run after the generic ones here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseHours, replayGoldDay } from '../../tools/goldReplay.ts'

const GOLD = process.env.GOLD_DIR
if (!GOLD || !existsSync(path.join(GOLD, 'gold.json'))) {
  throw new Error(`No gold day at GOLD_DIR (${GOLD ?? 'not set'}). Set it to a gold-day folder; gold tests never pass without one.`)
}
const CHECKS = path.join(GOLD, 'checks.gold.ts')
if (!existsSync(CHECKS)) throw new Error(`The gold day has no checks.gold.ts at ${CHECKS}.`)
const cfg = JSON.parse(readFileSync(path.join(GOLD, 'gold.json'), 'utf8')) as {
  date: string
  tz: string
  utc_offset_min: number
  hours: string
  extension_browsers: string[]
  packet: { stale_title_min: number; nearby_hours: number; open_thread_min: number }
}
const replay = await replayGoldDay({
  goldDir: GOLD,
  date: cfg.date,
  tz: cfg.tz,
  utcOffsetMin: cfg.utc_offset_min,
  hours: parseHours(cfg.hours),
  extensionBrowsers: cfg.extension_browsers,
  packet: { staleTitleMs: cfg.packet.stale_title_min * 60_000, nearbyHours: cfg.packet.nearby_hours, openThreadMs: cfg.packet.open_thread_min * 60_000 },
})
replay.close()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

test('the replay builds exactly the frozen packets and refs, and the manifest has no others', () => {
  const manifest = JSON.parse(readFileSync(path.join(GOLD, 'MANIFEST.sha256.json'), 'utf8')) as Record<string, string>
  const built = new Set<string>()
  for (const [h, b] of replay.packets) {
    const name = `hour_${String(h).padStart(2, '0')}.json`
    built.add(`packets/${name}`).add(`refs/${name}`)
    assert.equal(sha(JSON.stringify(b.packet)), manifest[`packets/${name}`], `packets/${name}`)
    assert.equal(sha(JSON.stringify(b.refs)), manifest[`refs/${name}`], `refs/${name}`)
  }
  assert.deepEqual(Object.keys(manifest).sort(), [...built].sort())
})

test('every short ID in a packet has a source, and every source is in its packet', () => {
  for (const [h, b] of replay.packets) {
    const ids = [...JSON.stringify(b.packet).matchAll(/"id":"([a-z]\d+)"/g)].map((m) => m[1]!)
    assert.deepEqual(new Set(ids), new Set(Object.keys(b.refs)), `hour ${h}`)
    assert.equal(ids.length, new Set(ids).size, `hour ${h}: IDs are unique`)
  }
})

const day = (await import(pathToFileURL(CHECKS).href)) as { default: (ctx: unknown) => void | Promise<void> }
await day.default({ test, assert, goldDir: GOLD, repo: fileURLToPath(new URL('../..', import.meta.url)), packets: replay.packets })
