import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'

type ButtonProps = { kind?: 'primary' | 'secondary' | 'quiet' | 'danger'; size?: 'regular' | 'small' } & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ kind = 'secondary', size = 'small', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn ${kind} ${size} ${className}`} {...rest} />
}

export function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon-btn" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
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
