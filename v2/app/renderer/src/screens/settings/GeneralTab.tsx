// Settings › General.
import type { ShellState } from '../../../../shared/types.ts'
import { act } from '../../lib/api.ts'
import { Segmented, Toggle } from '../../ui/controls.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { errorText } from '../../ui/status.tsx'
import { Row } from './Row.tsx'

export function GeneralTab({ shell }: { shell: ShellState | null }) {
  const toast = useToast()
  if (!shell) return null
  return (
    <div className="settings-group">
      <Row label="Open at login" detail="Daylens opens when you log in.">
        <Toggle
          label="Open at login"
          on={shell.login_item}
          onChange={async (on) => {
            const r = await act({ a: 'login_item', on })
            if (!r.ok) toast({ text: errorText(r.error), error: true })
          }}
        />
      </Row>
      <Row label="Appearance">
        <Segmented
          label="Appearance"
          value={shell.appearance}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
          onChange={(mode) => void act({ a: 'appearance', mode })}
        />
      </Row>
    </div>
  )
}
