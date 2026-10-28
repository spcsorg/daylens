// Times each statement of the first retention batches on a database copy: node tools/prunestatements.ts <dir> <days>
import Database from 'better-sqlite3'
import path from 'node:path'
const [dir, keep] = process.argv.slice(2) as [string, string]
const db = new Database(path.join(dir, 'daylens-v2.sqlite'))
db.pragma('secure_delete = ON')
db.pragma('cache_size = -2000')
const last = (db.prepare('SELECT max(event_wall_ms) AS t FROM observations').get() as { t: number }).t
const cutoff = last - Number(keep) * 86_400_000
const t = (label: string, f: () => unknown) => {
  const s = performance.now()
  f()
  return [label, performance.now() - s] as const
}
for (let b = 0; b < 12; b++) {
  const steps = [
    t('observations', () => db.prepare('DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms < ? ORDER BY event_wall_ms LIMIT 500)').run(cutoff)),
    t('intervals', () => db.prepare('DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE start_wall_ms < ? ORDER BY start_wall_ms LIMIT 500)').run(cutoff)),
    t('search+hours', () =>
      db.transaction(() => {
        db.prepare(`DELETE FROM search_docs WHERE id IN (SELECT id FROM search_docs WHERE hour_start_wall_ms < ? AND last_wall_ms < ? LIMIT 50)`).run(cutoff, cutoff)
        db.prepare('DELETE FROM hours WHERE id IN (SELECT id FROM hours WHERE end_wall_ms <= ? LIMIT 20)').run(cutoff)
      }).immediate(),
    ),
  ]
  console.log(`batch ${b}: ` + steps.map(([l, ms]) => `${l} ${ms.toFixed(1)}`).join(', '))
}
db.close()
