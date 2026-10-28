// Runs live.ts once per --run, in order, and stops at the first run that did not start or stopped because someone may
// be at the Mac, or that was killed or failed. Every run checks the away gate again itself. Usage:
//   node browser/tools/queue.ts --run "canary --browser cft ..." --run "canary --browser firefox --local ..."

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ABORTED_EXIT, NOT_AWAY_EXIT } from './away.ts'

export type Exec = (args: string[]) => number

// Returns each run's exit code, up to and including the one that stopped the queue.
export function runQueue(runs: string[][], exec: Exec): number[] {
  const codes: number[] = []
  for (const args of runs) {
    const code = exec(args)
    codes.push(code)
    if (code === NOT_AWAY_EXIT || code === ABORTED_EXIT) break
  }
  return codes
}

// Splits one --run value into arguments, honouring double quotes around paths with spaces.
export function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { run: { type: 'string', multiple: true } } })
  const live = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live.ts')
  const runs = (values.run ?? []).map(splitArgs)
  const codes = runQueue(runs, (args) => spawnSync(process.execPath, [live, ...args], { stdio: 'inherit' }).status ?? ABORTED_EXIT)
  codes.forEach((c, i) => process.stdout.write(`run ${i + 1} (${runs[i]!.slice(0, 3).join(' ')}): exit ${c}\n`))
  if (codes.length < runs.length) process.stdout.write(`stopped after run ${codes.length}\n`)
  const last = codes.at(-1)
  process.exit(last === NOT_AWAY_EXIT || last === ABORTED_EXIT ? last : codes.some((c) => c !== 0) ? 1 : 0)
}
