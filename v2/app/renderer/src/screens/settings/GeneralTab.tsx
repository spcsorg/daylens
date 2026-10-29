// Settings › General.
import type { ShellState } from '../../../../shared/types.ts'
import { act } from '../../lib/api.ts'
import { Toggle } from '../../ui/controls.tsx'
import { useToast } from '../../ui/overlays.tsx'
import { errorText } from '../../ui/status.tsx'
import { Row, Section } from './Row.tsx'

export function GeneralTab({ shell }: { shell: ShellState | null }) {
  const toast = useToast()
  if (!shell) return null
  return (
    <>
      <Section title="Startup">
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
      </Section>
      <Section title="Appearance">
        <div className="appearance" role="group" aria-label="Appearance">
          {APPEARANCE.map((o) => (
            <button
              type="button"
              key={o.value}
              aria-pressed={shell.appearance === o.value}
              className="appearance-option"
              onClick={async () => {
                recolour()
                const r = await act({ a: 'appearance', mode: o.value })
                if (!r.ok) toast({ text: errorText(r.error), error: true })
              }}
            >
              <span className="appearance-thumb" aria-hidden="true">
                {o.value !== 'dark' && <MiniWindow look="light" />}
                {o.value !== 'light' && <MiniWindow look="dark" />}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

// Lets the theme change ease across every surface at once; the class comes off once the new colours have landed.
function recolour(): void {
  const root = document.documentElement
  root.classList.add('theme-changing')
  window.setTimeout(() => root.classList.remove('theme-changing'), 400)
}

// A small picture of the window in each look, so the choice is seen, not read. Match system shows both, split.
function MiniWindow({ look }: { look: 'light' | 'dark' }) {
  return (
    <span className={`mini ${look}`}>
      <span className="mini-sidebar" />
      <span className="mini-main">
        <span />
        <span />
        <span />
      </span>
    </span>
  )
}

const APPEARANCE: { value: ShellState['appearance']; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
]
