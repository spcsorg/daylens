// Decides what the extension tells Daylens. Only the focused tab of a focused normal window is a page.
// Anything the extension cannot see (another app, a private window, devtools, no window) is unknown, sent at once.
// Each event starts a new generation; an async lookup that finishes after a newer event is thrown away.

import { cleanAddress } from '../../../capture/address.ts'

export const WINDOW_ID_NONE = -1

export interface Win {
  id?: number
  focused: boolean
  incognito: boolean
  type?: string
}

export interface Tab {
  id?: number
  windowId: number
  active: boolean
  incognito: boolean
  url?: string
  title?: string
}

export interface TabsApi {
  allWindows(): Promise<Win[]>
  activeTab(windowId: number): Promise<Tab | undefined>
}

export type Trigger = 'activated' | 'focus' | 'updated' | 'removed' | 'snapshot' | 'startup' | 'paused'
export type UnknownReason = 'no_focused_window' | 'not_normal' | 'no_tab' | 'no_address' | 'paused'

export type TabMessage =
  | { t: 'tab'; state: 'page'; trigger: Trigger; window: string; tab: string | null; url: string; title: string | null }
  | { t: 'tab'; state: 'unknown'; trigger: Trigger; reason: UnknownReason }

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const code = s.charCodeAt(max - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

export class Tracker {
  private readonly api: TabsApi
  private readonly send: (msg: TabMessage) => void
  private gen = 0
  private lastKey: string | null = null
  private paused = false

  constructor(api: TabsApi, send: (msg: TabMessage) => void) {
    this.api = api
    this.send = send
  }

  focusChanged(windowId: number): Promise<void> {
    if (windowId === WINDOW_ID_NONE) {
      this.gen++
      if (this.paused) return Promise.resolve()
      this.emit({ t: 'tab', state: 'unknown', trigger: 'focus', reason: 'no_focused_window' }, false)
      return Promise.resolve()
    }
    return this.refresh('focus')
  }

  activated(): Promise<void> {
    return this.refresh('activated')
  }

  updated(tab: Tab, change: { url?: string; title?: string }): Promise<void> {
    if (!tab.active || (change.url === undefined && change.title === undefined)) return Promise.resolve()
    return this.refresh('updated')
  }

  removed(): Promise<void> {
    return this.refresh('removed')
  }

  // Daylens asked for the present state: always answered, even when nothing changed.
  snapshot(): Promise<void> {
    return this.refresh('snapshot', true)
  }

  startup(): Promise<void> {
    return this.refresh('startup', true)
  }

  // Forget what was sent, so the next state goes out even if it matches (a new connection to Daylens).
  reset(): void {
    this.lastKey = null
  }

  setPaused(paused: boolean): Promise<void> {
    if (paused === this.paused) return Promise.resolve()
    this.paused = paused
    if (paused) {
      this.gen++
      this.emit({ t: 'tab', state: 'unknown', trigger: 'paused', reason: 'paused' }, true)
      return Promise.resolve()
    }
    return this.refresh('snapshot', true)
  }

  private async refresh(trigger: Trigger, force = false): Promise<void> {
    const g = ++this.gen
    const unknown = (reason: UnknownReason) => this.emit({ t: 'tab', state: 'unknown', trigger, reason }, force)
    if (this.paused) return unknown('paused')
    let wins: Win[]
    try {
      wins = await this.api.allWindows()
    } catch {
      if (g === this.gen) unknown('no_focused_window')
      return
    }
    if (g !== this.gen) return
    const w = wins.find((x) => x.focused)
    if (!w || w.id === undefined || w.id === WINDOW_ID_NONE) return unknown('no_focused_window')
    if (w.incognito || w.type !== 'normal') return unknown('not_normal')
    let tab: Tab | undefined
    try {
      tab = await this.api.activeTab(w.id)
    } catch {
      tab = undefined
    }
    if (g !== this.gen) return
    if (!tab || tab.windowId !== w.id) return unknown('no_tab')
    if (tab.incognito) return unknown('not_normal')
    const url = cleanAddress(tab.url)
    if (url === null) return unknown('no_address')
    // A page can set a title with an unpaired surrogate; send well-formed text so no parser on the way trips on it.
    const title = tab.title ? clip(tab.title.toWellFormed(), 1024) : null
    this.emit({ t: 'tab', state: 'page', trigger, window: String(w.id), tab: tab.id === undefined ? null : String(tab.id), url, title }, force)
  }

  private emit(msg: TabMessage, force: boolean): void {
    const { trigger: _trigger, ...rest } = msg
    const key = JSON.stringify(rest)
    if (!force && key === this.lastKey) return
    this.lastKey = key
    this.send(msg)
  }
}
