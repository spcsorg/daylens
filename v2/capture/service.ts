// Capture service process: supervisor + normalization + storage. Runs outside the interface process.
// Usage: node capture/service.ts --helper <path> [--data-dir <dir>] [--deletion-stall-ms 60000] [--heartbeat-s 15] [--idle-threshold-s 120] [--reconcile-s 60]
//        [--agent-sessions]   reads Claude Code and Codex session logs (agent session metadata is recorded only with permission)
//        [--browser-history]  reads browser history files (macOS), from the start of the day they are first read
//        [--v1-app-data <dir>] a new store starts with the pause and exclusions V1 kept under this folder

import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'
import { backfill, stopBackfills } from './agents/backfill.ts'
import { HostResolver } from './agents/host.ts'
import { AgentReader, homeRoots } from './agents/reader.ts'
import { AgentStore, removeStaging } from './agents/store.ts'
import { WslDiscovery } from './agents/wsl.ts'
import { BrowserPages } from './browser.ts'
import { DELETION_STALL_MS } from './defaults.ts'
import { FROM_KEY as HISTORY_FROM_KEY, historyCopyDir, HistoryReader } from './history.ts'
import { BrowserLocal, helperPeerCheck, localEnabled } from './browserLocal.ts'
import { BrowserSocket, statusMsg } from './browserSocket.ts'
import { handleControl } from './control.ts'
import { Privacy } from './normalize.ts'
import { storagePause } from './pause.ts'
import { ServiceNormalizer } from './pipeline.ts'
import { helperSecrets } from './secrets.ts'
import { defaultDataDir, PAUSE_OWED_KEY, Store } from './store.ts'
import { Supervisor } from './supervisor.ts'
import { readOrderingPoint } from './ordering.ts'
import { readV1Privacy } from './v1Privacy.ts'
import { Storage } from '../storage/index.ts'

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
    'deletion-stall-ms': { type: 'string', default: String(DELETION_STALL_MS) },
    'agent-sessions': { type: 'boolean', default: false },
    'browser-history': { type: 'boolean', default: false },
    'v1-app-data': { type: 'string' },
  },
})

const deletionStallMs = Number(values['deletion-stall-ms'])
if (!values.helper || !(deletionStallMs > 0)) {
  process.stderr.write('usage: service.ts --helper <path> [--data-dir <dir>] [--deletion-stall-ms <ms>]\n')
  process.exit(64)
}

const heartbeatS = Number(values['heartbeat-s'])
const log = (msg: string) => process.stderr.write(`[capture] ${msg}\n`)
const dataDir = values['data-dir'] ?? defaultDataDir()
const v1AppData = values['v1-app-data']
const store = new Store(dataDir, {
  onError: (code) => log(`storage error code=${code}`),
  firstSeed: v1AppData
    ? () => {
        const v1 = readV1Privacy(v1AppData)
        if (v1) log(`v1 privacy carried rules=${v1.rules.length} paused=${v1.paused ? 1 : 0} unresolved_apps=${v1.unresolved}`)
        return v1
      }
    : undefined,
})
// The app reads this from stdout: whether capture's writes fail, are held off by another writer, were dropped, or
// still owe a scrub. Written whenever one of those changes, and once at the first write.
store.onHealth = (h) => process.stdout.write(JSON.stringify({ op: 'capture_health', store: h }) + '\n')
const storage = new Storage(store, dataDir, {
  deletionStallMs,
  onError: (code) => log(`storage error code=${code}`),
  orderingPoint: () => readOrderingPoint(values.helper!, values['helper-arg'] ?? [], log),
})
// A first read cut short after its merge leaves its staging copy; with or without agent access it is removed here.
removeStaging(dataDir)
storage.onDeleted = () => stopBackfills()
const privacy = new Privacy(store.exclusions())
const pages = new BrowserPages(store, privacy, { log })
let supervisor: Supervisor | null = null
let browserSocket: BrowserSocket | null = null
let browserLocal: BrowserLocal | null = null
const pause = storagePause(storage)
// A new store owes V1's pause; it is in force before the helper starts, and only cleared once it is. History is read
// from then, not from the start of the day: V1 recorded nothing earlier today either. The pause flushes that first.
if (store.meta(PAUSE_OWED_KEY) !== null) {
  store.setMeta(HISTORY_FROM_KEY, String(Date.now()))
  storage.pause(null)
  store.setMeta(PAUSE_OWED_KEY, null)
}
// Every pause change reaches the extensions: a pause of everything shows in their status.
storage.bus.on((change) => {
  if (change.kind !== 'pause') return
  const state = pause.state()
  log(`capture ${state.paused ? 'paused' : 'resumed'}${change.payload.app ? ' scope=app' : ''}`)
  browserSocket?.broadcast(statusMsg(state))
  browserLocal?.status(state)
})
const normalizer = new ServiceNormalizer(store, privacy, pages)
const out = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n')
// The app refreshes the current hour when told; at most one line a second, after new observations are derived.
const derived = store.onFlushed
let activityTimer: ReturnType<typeof setTimeout> | null = null
store.onFlushed = (ids) => {
  derived(ids)
  activityTimer ??= setTimeout(() => {
    activityTimer = null
    out({ op: 'activity' })
  }, 1000)
}
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

supervisor.onStatus = (status) => out({ op: 'helper_status', ...status })

storage.attachCapture({
  interrupt: () => {
    normalizer.interrupt(supervisor!.currentPoint())
    supervisor!.requestSnapshot()
    pages.requestSnapshots()
  },
  setPrivacy: (privacy) => {
    normalizer.setPrivacy(privacy)
    pages.setPrivacy(privacy)
  },
})
function agentStore(): AgentStore {
  return Object.assign(new AgentStore(store.database), storage.agentPolicy(), { onRemoved: () => void store.retryScrub() })
}

const wsl = process.platform === 'win32' ? new WslDiscovery() : null
const hosts = process.platform === 'darwin' ? new HostResolver({ claudeDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), helper: values.helper, helperArgs: values['helper-arg'] ?? [], revalidateMs: Number(values['reconcile-s']) * 1000 }) : null
const agents = values['agent-sessions']
  ? new AgentReader(agentStore(), homeRoots(os.homedir()), {
      reconcileMs: Number(values['reconcile-s']) * 1000,
      log,
      backfill: async (roots) => {
        const r = await backfill(store.database, dataDir, roots, log, undefined, undefined, storage.agentPolicy())
        if (r.child) log(`agent backfill files=${r.child.files_read} mb=${r.child.mb_read} wall_ms=${r.child.wall_ms} merge_ms=${r.merge_ms}`)
        return r.merged
      },
      ...(wsl ? { discover: () => wsl.discover() } : {}),
      // Only the macOS helper can name the app a process runs in; elsewhere sessions have no known app.
      ...(hosts ? { resolveHost: (agent, session, file) => hosts.resolve(agent, session, file) } : {}),
    })
  : null

// DAYLENS_V2_HISTORY_HOME points the readers at another home folder: test profiles, never the person's own.
const history =
  values['browser-history'] && process.platform === 'darwin'
    ? new HistoryReader(store, { home: process.env.DAYLENS_V2_HISTORY_HOME ?? os.homedir(), copyDir: historyCopyDir(dataDir), intervalMs: Number(values['reconcile-s']) * 1000, log })
    : null

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log(`stopping signal=${signal}`)
  await browserSocket?.stop()
  await browserLocal?.stop()
  await supervisor!.stop()
  await agents?.stop()
  await history?.stop()
  storage.stop()
  store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGHUP', () => void shutdown('SIGHUP'))
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'))
// Windows has no SIGTERM: the parent stops capture by closing this pipe, and a parent that dies closes it too.
// A utility process has no stdin; Electron ends it with its parent.
const parentPort = (process as { parentPort?: { on(e: 'message', f: (m: { data: unknown }) => void): void } }).parentPort
if (!parentPort && (process.platform === 'win32' || process.env.DAYLENS_CAPTURE_EXIT_ON_STDIN_EOF === '1')) process.stdin.on('end', () => void shutdown('stdin_eof')).resume()

log(`started pid=${process.pid}`)
supervisor.start()
storage.start()
history?.start()
agents?.start().catch((err: unknown) => log(`agent reader failed code=${(err as { code?: unknown })?.code ?? 'unknown'}`))
browserSocket = new BrowserSocket(pages, pause, { log })
void browserSocket.start()
if (localEnabled()) {
  browserLocal = new BrowserLocal(pages, pause, store, {
    peerCheck: helperPeerCheck(values.helper),
    secrets: helperSecrets(values.helper),
    clock: () => normalizer.clock(),
    log,
    // The app shows Allow / Don't allow and answers with pair_decision on stdin.
    confirm: (req) => process.stdout.write(JSON.stringify(req) + '\n'),
  })
  void browserLocal.start()
}
// Only the parent (the Daylens app) writes here: control ops from the interface, and daylens://pair links the operating
// system delivered to it. Run as an Electron utility process, the parent sends each line as a message instead.
function onControl(raw: string): void {
  let msg: { op?: unknown; link?: unknown; id?: unknown; allow?: unknown }
  try {
    msg = JSON.parse(raw)
  } catch {
    return void log('control rejected reason=not_json')
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return void log('control rejected reason=not_object')
  if (msg.op === 'stop') return void shutdown('stop')
  if (handleControl(storage, msg, out)) return
  if (msg.op === 'pair' && typeof msg.link === 'string' && browserLocal) browserLocal.addPairLink(msg.link)
  else if (msg.op === 'unpair' && typeof msg.id === 'string' && browserLocal) browserLocal.unpair(msg.id)
  else if (msg.op === 'pair_decision' && typeof msg.id === 'string' && typeof msg.allow === 'boolean' && browserLocal) browserLocal.decide(msg.id, msg.allow)
  else log('control rejected reason=unknown_op')
}
if (parentPort) parentPort.on('message', ({ data }) => {
  if (typeof data === 'string') onControl(data)
})
else createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', onControl)
