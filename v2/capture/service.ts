// Capture service process: supervisor + normalization + storage. Runs outside the interface process.
// Usage: node capture/service.ts --helper <path> [--data-dir <dir>] [--heartbeat-s 15] [--idle-threshold-s 120] [--reconcile-s 60]

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'
import { BrowserPages } from './browser.ts'
import { BrowserLocal, helperPeerCheck, localEnabled } from './browserLocal.ts'
import { BrowserSocket, statusMsg } from './browserSocket.ts'
import { Privacy } from './normalize.ts'
import { Pause } from './pause.ts'
import { ServiceNormalizer } from './pipeline.ts'
import { defaultDataDir, Store } from './store.ts'
import { Supervisor } from './supervisor.ts'

const { values } = parseArgs({
  options: {
    helper: { type: 'string' },
    'helper-arg': { type: 'string', multiple: true },
    'data-dir': { type: 'string' },
    'heartbeat-s': { type: 'string', default: '15' },
    'idle-threshold-s': { type: 'string', default: '120' },
    'reconcile-s': { type: 'string', default: '60' },
    'hang-after-s': { type: 'string' },
    'tick-ms': { type: 'string' },
  },
})

if (!values.helper) {
  process.stderr.write('usage: service.ts --helper <path> [--data-dir <dir>]\n')
  process.exit(64)
}

const heartbeatS = Number(values['heartbeat-s'])
const log = (msg: string) => process.stderr.write(`[capture] ${msg}\n`)
const store = new Store(values['data-dir'] ?? defaultDataDir(), { onError: (code) => log(`storage error code=${code}`) })
const privacy = new Privacy(store.exclusions())
const pages = new BrowserPages(store, privacy, { log })
let supervisor: Supervisor | null = null
let browserSocket: BrowserSocket | null = null
let browserLocal: BrowserLocal | null = null
const pause = new Pause(store, {
  onChange: (state, at) => {
    log(`capture ${state.paused ? 'paused' : 'resumed'}`)
    normalizer.interrupt(at)
    if (!state.paused) {
      supervisor?.requestSnapshot()
      pages.requestSnapshots()
    }
    browserSocket?.broadcast(statusMsg(state))
    browserLocal?.status(state)
  },
})
const normalizer = new ServiceNormalizer(store, privacy, pause, pages)
supervisor = new Supervisor(store, normalizer, {
  helperPath: values.helper,
  helperArgs: [
    ...(values['helper-arg'] ?? []),
    '--heartbeat-s', String(heartbeatS),
    '--idle-threshold-s', values['idle-threshold-s'],
    '--reconcile-s', values['reconcile-s'],
  ],
  heartbeatMs: heartbeatS * 1000,
  hangAfterMs: values['hang-after-s'] ? Number(values['hang-after-s']) * 1000 : heartbeatS * 3000,
  tickMs: values['tick-ms'] ? Number(values['tick-ms']) : Math.max(250, Math.round((heartbeatS * 1000) / 3)),
  log,
})

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log(`stopping signal=${signal}`)
  pause.stop()
  await browserSocket?.stop()
  await browserLocal?.stop()
  await supervisor!.stop()
  store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGHUP', () => void shutdown('SIGHUP'))
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'))
// Windows has no SIGTERM: the parent stops capture by closing this pipe, and a parent that dies closes it too.
if (process.platform === 'win32' || process.env.DAYLENS_CAPTURE_EXIT_ON_STDIN_EOF === '1') process.stdin.on('end', () => void shutdown('stdin_eof')).resume()

log(`started pid=${process.pid}`)
pause.restore()
supervisor.start()
browserSocket = new BrowserSocket(pages, pause, { log })
void browserSocket.start()
if (localEnabled()) {
  browserLocal = new BrowserLocal(pages, pause, store, {
    peerCheck: helperPeerCheck(values.helper),
    clock: () => normalizer.clock(),
    log,
    // The app shows Allow / Don't allow and answers with pair_decision on stdin.
    confirm: (req) => process.stdout.write(JSON.stringify(req) + '\n'),
  })
  void browserLocal.start()
  // Only the parent (the Daylens app) writes here: daylens://pair links the operating system delivered to it.
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (raw) => {
    let msg: { op?: unknown; link?: unknown; id?: unknown; allow?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return log('control rejected reason=not_json')
    }
    if (msg.op === 'pair' && typeof msg.link === 'string') browserLocal?.addPairLink(msg.link)
    else if (msg.op === 'unpair' && typeof msg.id === 'string') browserLocal?.unpair(msg.id)
    else if (msg.op === 'pair_decision' && typeof msg.id === 'string' && typeof msg.allow === 'boolean') browserLocal?.decide(msg.id, msg.allow)
    else log('control rejected reason=unknown_op')
  })
}
