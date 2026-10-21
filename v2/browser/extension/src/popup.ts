import type { PauseFor, PopupRequest, PopupState } from './messages.ts'

interface Ext {
  runtime: { sendMessage(req: PopupRequest): Promise<PopupState> }
}
const g = globalThis as unknown as { browser?: Ext; chrome?: Ext }
const ext = (g.browser ?? g.chrome)!

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = $('status')
const connectBtn = $<HTMLButtonElement>('connect')
const pauseBtn = $<HTMLButtonElement>('pause')
const choices = $('choices')
const resumeBtn = $<HTMLButtonElement>('resume')
const openBtn = $<HTMLButtonElement>('open')
const error = $('error')

function at(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`
}

function statusLine(s: PopupState): [string, 'ok' | 'warn' | 'none'] {
  if (s.daylens === 'connecting') return ['Connecting…', 'none']
  if (s.daylens === 'not_installed') return ['Daylens isn’t installed on this computer', 'none']
  if (s.awaiting_allow) return ['Allow this browser in Daylens', 'none']
  if (s.connecting_pair && s.daylens !== 'connected') return ['Waiting for Daylens…', 'none']
  if (s.daylens === 'unpaired') return ['Not connected to Daylens', 'none']
  if (s.daylens === 'not_running') return ['Daylens isn’t running', 'warn']
  if (s.paused) return [s.paused_until_wall_ms === null ? 'Paused in this browser' : `Paused in this browser until ${at(s.paused_until_wall_ms)}`, 'warn']
  if (s.capture === 'paused') return [s.until_wall_ms === null ? 'Daylens is paused' : `Daylens is paused until ${at(s.until_wall_ms)}`, 'warn']
  return ['Connected', 'ok']
}

function render(s: PopupState): void {
  const connected = s.daylens === 'connected'
  const [text, tone] = statusLine(s)
  status.textContent = text
  status.dataset.tone = tone
  connectBtn.hidden = s.daylens !== 'unpaired' || s.connecting_pair
  pauseBtn.hidden = !connected || s.paused || s.capture === 'paused' || !choices.hidden
  resumeBtn.hidden = !s.paused
  if (!connected || s.paused || s.capture === 'paused') choices.hidden = true
  openBtn.hidden = s.daylens === 'not_installed' || s.daylens === 'connecting' || s.daylens === 'unpaired'
  openBtn.classList.toggle('link', connected)
  openBtn.classList.toggle('primary', !connected)
}

function fail(text: string): void {
  error.textContent = text
  error.hidden = false
}

async function ask(req: PopupRequest): Promise<PopupState | null> {
  error.hidden = true
  try {
    const s = await ext.runtime.sendMessage(req)
    render(s)
    return s
  } catch {
    fail('Couldn’t reach the extension. Close this and try again.')
    return null
  }
}

connectBtn.addEventListener('click', async () => {
  const s = await ask({ t: 'connect' })
  if (s && !s.connecting_pair && s.daylens !== 'connected') fail('Couldn’t start connecting. Try again.')
})
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
  if (s && !s.paused) fail('This browser didn’t pause. Try again.')
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
  if (s && s.paused) fail('This browser is still paused. Try again.')
})
openBtn.addEventListener('click', async () => {
  const s = await ask({ t: 'open' })
  if (s && s.opened) window.close()
  else if (s) fail('Couldn’t open Daylens. Open it from your apps.')
})

void ask({ t: 'status' })
