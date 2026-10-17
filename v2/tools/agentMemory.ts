import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

export async function measureScan(home: string, data: string, source = false) {
  const ext = path.extname(fileURLToPath(import.meta.url))
  if (ext === '.ts' && !source) {
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
    await exec(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')])
  }
  const scan = ext === '.ts' && !source ? path.join(root, 'build/js/tools/agentScan.js') : fileURLToPath(new URL(`./agentScan${ext}`, import.meta.url))
  const child = spawn(process.execPath, [scan, '--home', home, '--data-dir', data, '--again'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (s: string) => (out += s))
  child.stderr.setEncoding('utf8').on('data', (s: string) => (err += s))
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`scan exited ${code}: ${err}`)))
  })
  let combined = 0
  let parent = 0
  let backfill = 0
  let samplesWithChild = 0
  let running = true
  const sampling = (async () => {
    while (running) {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss='])
      const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      const own = rows.find(([pid]) => pid === child.pid)?.[2] ?? 0
      const descendants = new Set([child.pid])
      for (let previous = -1; previous !== descendants.size;) {
        previous = descendants.size
        for (const [pid, ppid] of rows) if (descendants.has(ppid)) descendants.add(pid)
      }
      const kids = rows.filter(([pid]) => pid !== child.pid && descendants.has(pid)).reduce((sum, r) => sum + r[2]!, 0)
      if (kids > 0) samplesWithChild++
      const bytes = (own + kids) * 1024
      if (bytes > combined) {
        combined = bytes
        parent = own * 1024
        backfill = kids * 1024
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })()
  try {
    await Promise.race([exited, sampling])
  } catch (err) {
    child.kill()
    await exited.catch(() => {})
    throw err
  } finally {
    running = false
    await sampling
  }
  return { runtime: path.extname(scan) === '.js' ? 'javascript' : 'typescript', combined_peak_mb: combined / 1e6, parent_at_peak_mb: parent / 1e6, child_at_peak_mb: backfill / 1e6, samples_with_child: samplesWithChild, passes: out.trim().split('\n').map((line) => JSON.parse(line)) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await measureScan(process.argv[2]!, process.argv[3]!, process.argv.includes('--source')), null, 2))
