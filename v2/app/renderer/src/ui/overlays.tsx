import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.tsx'

export function Dialog({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // At the top level: inside a moved or animated card the scrim would cover only the card.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** A popover anchored under its trigger, closed by Escape or a click outside. */
export function Popover({ open, onClose, children, align = 'right', className = '' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Captured and stopped: Escape closes the popover alone, not a dialog it sits in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className={`popover ${className}`} style={{ top: 'calc(100% + 4px)', [align]: 0 }}>
      {children}
    </div>
  )
}

interface ToastMsg {
  text: string
  error?: boolean
  // One step back, such as Undo; the toast stays a little longer to give time for it.
  action?: { label: string; run: () => void }
}

const ToastContext = createContext<(t: ToastMsg) => void>(() => {})

export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastMsg & { n: number }) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((t: ToastMsg) => {
    setToast((prev) => ({ ...t, n: (prev?.n ?? 0) + 1 }))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), t.error || t.action ? 6000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.n} className={`toast${toast.error ? ' error' : ''}`} role="status">
          <Icon name={toast.error ? 'alert' : 'check'} />
          {toast.text}
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                setToast(null)
                toast.action!.run()
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
