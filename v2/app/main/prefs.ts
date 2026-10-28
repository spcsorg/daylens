import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { paths } from './paths.ts'

export interface Prefs {
  appearance: 'light' | 'dark' | 'system'
  onboarded: boolean
}

export function loadPrefs(): Prefs {
  try {
    return { appearance: 'system', onboarded: false, ...(JSON.parse(readFileSync(paths.prefs(), 'utf8')) as Partial<Prefs>) }
  } catch {
    return { appearance: 'system', onboarded: false }
  }
}

export function writePrefs(prefs: Prefs): void {
  mkdirSync(path.dirname(paths.prefs()), { recursive: true })
  writeFileSync(paths.prefs(), JSON.stringify(prefs))
}
