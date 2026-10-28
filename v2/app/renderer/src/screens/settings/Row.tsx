import type { ReactNode } from 'react'

/** A setting: what it is, a line on what it does, and its control on the right. */
export function Row({ label, detail, children }: { label: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {detail && <span className="settings-row-detail">{detail}</span>}
      </div>
      {children}
    </div>
  )
}

/** A tab whose controls come in a later update. */
export function Later({ text }: { text: string }) {
  return <p className="settings-later">{text}</p>
}
