import type { PauseFor, PopupRequest, PopupState } from './messages.ts'

interface Ext {
  runtime: { sendMessage(req: PopupRequest): Promise<PopupState> }
}
const g = globalThis as unknown as { browser?: Ext; chrome?: Ext }
const ext = (g.browser ?? g.chrome)!

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = $('status')
const pauseBtn = $<HTMLButtonElement>('pause')
const choices = $('choices')
const resumeBtn = $<HTMLButtonElement>('resume')
const openBtn = $<HTMLButtonElement>('open')
const error = $('error')

function untilText(ms: number): string {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Paused until ${time}` : `Paused until ${d.toLocaleDateString([], { weekday: 'long' })} ${time}`
}

function statusLine(s: PopupState, paused: boolean): [string, 'ok' | 'warn' | 'none'] {
  if (s.daylens === 'connecting') return ['Connecting…', 'none']
  if (s.daylens === 'not_installed') return ['Daylens isn’t installed on this computer', 'none']
  if (s.daylens === 'not_running') return ['Daylens isn’t running', 'warn']
  if (paused) return [s.until_wall_ms === null ? 'Paused' : untilText(s.until_wall_ms), 'warn']
  return ['Connected', 'ok']
}

function render(s: PopupState): void {
  const connected = s.daylens === 'connected'
  const paused = connected && s.capture === 'paused'
  const [text, tone] = statusLine(s, paused)
  status.textContent = text
  status.dataset.tone = tone
  pauseBtn.hidden = !connected || paused || !choices.hidden
  resumeBtn.hidden = !paused
  if (!connected || paused) choices.hidden = true
  openBtn.hidden = s.daylens === 'not_installed' || s.daylens === 'connecting'
  openBtn.classList.toggle('link', connected)
  openBtn.classList.toggle('primary', !connected)
}

async function ask(req: PopupRequest): Promise<PopupState | null> {
  error.hidden = true
  try {
    const s = await ext.runtime.sendMessage(req)
    render(s)
    return s
  } catch {
    error.textContent = 'Couldn’t reach the extension. Close this and try again.'
    error.hidden = false
    return null
  }
}

pauseBtn.addEventListener('click', () => {
  choices.hidden = false
  pauseBtn.hidden = true
  choices.querySelector('button')?.focus()
})
choices.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b) return
  choices.hidden = true
  const s = await ask({ t: 'pause', for: b.dataset.for as PauseFor })
  if (s && s.capture !== 'paused') {
    error.textContent = 'Daylens didn’t pause. Try again from Daylens.'
    error.hidden = false
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !choices.hidden) {
    choices.hidden = true
    pauseBtn.hidden = false
    pauseBtn.focus()
    e.preventDefault()
  }
})
resumeBtn.addEventListener('click', async () => {
  const s = await ask({ t: 'resume' })
  if (s && s.capture === 'paused') {
    error.textContent = 'Daylens is still paused. Try again from Daylens.'
    error.hidden = false
  }
})
openBtn.addEventListener('click', async () => {
  const s = await ask({ t: 'open' })
  if (s && s.opened) window.close()
  else if (s) {
    error.textContent = 'Couldn’t open Daylens. Open it from your apps.'
    error.hidden = false
  }
})

void ask({ t: 'status' })
