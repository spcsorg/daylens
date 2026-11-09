// Lists every skipped and todo test in a TAP report and fails if any reason lacks a SHIP ID in brackets.
// Usage: node --test --test-reporter=tap --test-reporter-destination=tests.tap ... && node tools/skips.ts tests.tap
import { readFileSync } from 'node:fs'

export interface Skip {
  name: string
  directive: 'SKIP' | 'TODO'
  reason: string
}

// node's TAP reporter writes `#` in names and reasons as `\#`, so only an unescaped ` # ` starts a directive.
const POINT = /^\s*(?:not )?ok \d+ - (.*?)(?: # (SKIP|TODO)(?: (.*))?)?$/
const unescape = (s: string) => s.replace(/\\([\\#])/g, '$1')

export const linked = (reason: string) => /\[[A-Z]-[A-Z]?\d+\]/.test(reason)

export function readSkips(tap: string): { tests: number; skips: Skip[] } {
  let tests = 0
  const skips: Skip[] = []
  for (const line of tap.split(/\r?\n/)) {
    const m = POINT.exec(line)
    if (!m) continue
    tests++
    if (m[2]) skips.push({ name: unescape(m[1]!), directive: m[2] as Skip['directive'], reason: unescape(m[3] ?? '') })
  }
  return { tests, skips }
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) throw new Error('usage: node tools/skips.ts <tap report>')
  const { tests, skips } = readSkips(readFileSync(file, 'utf8'))
  if (tests === 0) {
    console.error(`${file} has no test results`)
    process.exit(1)
  }
  for (const s of skips) console.log(`${s.directive} ${s.name}: ${s.reason || '(no reason)'}`)
  const unlinked = skips.filter((s) => !linked(s.reason))
  console.log(`${skips.length} of ${tests} tests skipped or todo, ${unlinked.length} without a SHIP ID`)
  if (unlinked.length) {
    for (const s of unlinked) console.error(`no SHIP ID in brackets: ${s.name} (${s.reason || 'no reason'})`)
    process.exit(1)
  }
}
