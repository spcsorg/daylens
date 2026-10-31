// Settings' reads: what is kept out and how long history is kept.
import { DEFAULT_EXCLUSIONS } from '../../capture/defaults.ts'
import { DAY_MS } from '../../storage/rules.ts'
import type { Exclusion, PrivacyView, SettingsQuery } from '../shared/settings.ts'
import type { Handlers, Reader } from './queries.ts'

function privacy(r: Reader): PrivacyView {
  // A default taken out and added back is stored as the person's own; it is still one of the defaults.
  const exclusions = (r.db.prepare('SELECT match, value, label, is_default FROM exclusions ORDER BY id').all() as (Omit<Exclusion, 'is_default'> & { is_default: number })[]).map((e) => ({
    ...e,
    is_default: e.is_default === 1 || DEFAULT_EXCLUSIONS.some((d) => d.match === e.match && d.value === e.value),
  }))
  const row = r.db.prepare(`SELECT value FROM settings WHERE key = 'retention_days'`).get() as { value: string } | undefined
  const now = r.now()
  return { exclusions, retention_days: row ? (JSON.parse(row.value) as number | null) : null, seen_apps: r.appTotals(r.spans(now - 14 * DAY_MS, now)), defaults: [...DEFAULT_EXCLUSIONS] }
}

export const settings: Handlers<SettingsQuery> = {
  privacy: ({ record }) => privacy(record),
}
