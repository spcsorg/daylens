import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'

type ButtonProps = {
  kind?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'large' | 'regular' | 'small'
  /** Shows a spinner in place of the label, at the same width. */
  loading?: boolean
  /** Return presses it, and it says so: onboarding's main button only. */
  enter?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ kind = 'secondary', size = 'small', loading = false, enter = false, className = '', type = 'button', disabled, children, ...rest }: ButtonProps) {
  const self = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!enter) return
    const onKey = (e: KeyboardEvent) => {
      // A focused field or button already handles Return itself.
      if (e.key !== 'Enter' || e.defaultPrevented || e.repeat || (e.target as Element).closest('input, textarea, button, a')) return
      e.preventDefault()
      self.current?.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enter])
  return (
    <button ref={self} type={type} className={`btn ${kind} ${size} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      <span className="btn-label">
        {children}
        {enter && <Icon name="enter" className="btn-enter" />}
      </span>
      {loading && (
        <span className="btn-busy">
          <Icon name="spinner" className="spin" />
        </span>
      )}
    </button>
  )
}

export function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon-btn" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null)
  const shown = useRef<T | null>(null)
  const [thumb, setThumb] = useState<{ x: number; w: number; slides: boolean } | null>(null)
  useLayoutEffect(() => {
    const slides = shown.current !== null && shown.current !== value
    shown.current = value
    const place = () => {
      const on = group.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
      if (on) setThumb({ x: on.offsetLeft, w: on.offsetWidth, slides })
    }
    place()
    // Geist may still be loading on first paint, which changes every option's width.
    if (document.fonts.status !== 'loaded') void document.fonts.ready.then(place)
  }, [value])
  return (
    <div ref={group} className="segmented" role="group" aria-label={label}>
      {thumb && <span className={`segmented-thumb${thumb.slides ? ' slides' : ''}`} style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box">
        <Icon name="check" size={14} />
      </span>
      {children}
    </label>
  )
}
