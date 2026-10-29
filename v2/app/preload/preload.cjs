// The interface's only way out: queries go straight to the reader over a MessagePort, actions go to the shell.
const { contextBridge, ipcRenderer } = require('electron')

let port = null
let nextId = 1
const waiting = new Map()
const queued = []
const listeners = new Set()

ipcRenderer.on('reader-port', (event) => {
  port = event.ports[0]
  port.onmessage = ({ data }) => {
    if (typeof data.id === 'number') {
      const w = waiting.get(data.id)
      waiting.delete(data.id)
      if (w) data.ok ? w.resolve(data.result) : w.reject(new Error(data.error))
    } else for (const l of listeners) l(data)
  }
  for (const msg of queued.splice(0)) port.postMessage(msg)
  for (const l of listeners) l({ e: 'changed', kinds: ['connected'] })
})

// A window opened to show Search gets 'navigate' before the page listens; the last one waits here until it does.
let navigateTo = null
let pendingNavigate = null
ipcRenderer.on('navigate', (_e, to) => (navigateTo ? navigateTo(to) : (pendingNavigate = to)))

contextBridge.exposeInMainWorld('daylens', {
  // Known before the first paint, so the window chrome never shifts once the shell state arrives.
  platform: process.platform,
  query: (query) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      const msg = { id, query }
      if (port) port.postMessage(msg)
      else queued.push(msg)
    }),
  onReader: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  action: (a) => ipcRenderer.invoke('action', a),
  shell: () => ipcRenderer.invoke('shell'),
  onShell: (fn) => {
    const h = (_e, s) => fn(s)
    ipcRenderer.on('shell', h)
    return () => ipcRenderer.removeListener('shell', h)
  },
  onNavigate: (fn) => {
    navigateTo = fn
    if (pendingNavigate) fn(pendingNavigate)
    pendingNavigate = null
    return () => {
      if (navigateTo === fn) navigateTo = null
    }
  },
  onDeletionFailed: (fn) => {
    const h = () => fn()
    ipcRenderer.on('deletion_failed', h)
    return () => ipcRenderer.removeListener('deletion_failed', h)
  },
})
