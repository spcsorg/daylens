// Builds the extension for each store and the unpacked dev build, and zips the store builds.
// Usage: node browser/build.ts [--out <dir>]
// Output JS is the TypeScript source compiled by tsc without minifying, comments kept, so reviewers read what was written.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ext = path.join(here, 'extension')
const { values } = parseArgs({ options: { out: { type: 'string', default: path.join(here, 'dist') } } })
const out = path.resolve(values.out!)

const compiled = mkdtempSync(path.join(os.tmpdir(), 'daylens-ext-'))
execFileSync(path.join(here, '..', 'node_modules', '.bin', 'tsc'), [
  '-p', path.join(here, 'tsconfig.json'), '--noEmit', 'false', '--outDir', compiled, '--rootDir', path.join(here, '..'),
  '--rewriteRelativeImportExtensions', '--removeComments', 'false', '--sourceMap', 'false', '--newLine', 'lf',
], { stdio: 'inherit' })

const SOURCES: [from: string, to: string][] = [
  [path.join(compiled, 'browser', 'extension', 'src', 'background.js'), 'background.js'],
  [path.join(compiled, 'browser', 'extension', 'src', 'focus.js'), 'focus.js'],
  [path.join(compiled, 'browser', 'extension', 'src', 'popup.js'), 'popup.js'],
  [path.join(compiled, 'browser', 'extension', 'src', 'local.js'), 'local.js'],
  [path.join(compiled, 'browser', 'extension', 'src', 'kv.js'), 'kv.js'],
  [path.join(compiled, 'browser', 'extension', 'src', 'config.js'), 'config.js'],
  [path.join(compiled, 'capture', 'address.js'), 'address.js'],
  [path.join(compiled, 'capture', 'pairing.js'), 'pairing.js'],
]

function transpile(file: string): string {
  return readFileSync(file, 'utf8').replace(/from '\.\.\/\.\.\/\.\.\/capture\/(address|pairing)\.js'/g, "from './$1.js'")
}

type Target = 'chromium' | 'firefox' | 'chromium-dev' | 'firefox-dev'

function build(target: Target): string {
  const dir = path.join(out, target)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'icons'), { recursive: true })
  for (const [from, to] of SOURCES) {
    let js = transpile(from)
    if (to === 'config.js' && target.endsWith('-dev')) {
      if (!js.includes('LOCAL_EVERYWHERE = false')) throw new Error('config.js: dev flag not found')
      js = js.replace('LOCAL_EVERYWHERE = false', 'LOCAL_EVERYWHERE = true')
    }
    if (/from '\.\.\//.test(js) || /from '[^']+\.ts'/.test(js)) throw new Error(`unrewritten import in ${to}`)
    writeFileSync(path.join(dir, to), js)
  }
  copyFileSync(path.join(ext, 'src', 'popup.html'), path.join(dir, 'popup.html'))
  copyFileSync(path.join(ext, 'src', 'popup.css'), path.join(dir, 'popup.css'))
  for (const f of readdirSync(path.join(ext, 'icons'))) copyFileSync(path.join(ext, 'icons', f), path.join(dir, 'icons', f))
  const base = JSON.parse(readFileSync(path.join(ext, target.startsWith('firefox') ? 'manifest.firefox.json' : 'manifest.chromium.json'), 'utf8'))
  const manifest = target === 'chromium-dev' ? { ...base, ...JSON.parse(readFileSync(path.join(ext, 'manifest.chromium-dev.json'), 'utf8')) } : base
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest.version as string
}

function zip(target: Target, version: string, name: string): string {
  const file = path.join(out, `${name}-${version}.zip`)
  rmSync(file, { force: true })
  execFileSync('/usr/bin/zip', ['-q', '-r', '-X', file, '.'], { cwd: path.join(out, target) })
  return file
}

mkdirSync(out, { recursive: true })
const chromium = build('chromium')
const firefox = build('firefox')
build('chromium-dev')
build('firefox-dev')
const zips = [zip('chromium', chromium, 'daylens-chromium'), zip('firefox', firefox, 'daylens-firefox')]
// Firefox reviewers rebuild from source whenever shipped code is generated, even by tsc.
const src = path.join(out, `daylens-firefox-source-${firefox}.zip`)
rmSync(src, { force: true })
execFileSync('/usr/bin/zip', ['-q', '-r', '-X', src, 'browser/extension', 'browser/build.ts', 'browser/tsconfig.json', 'browser/README.md', 'tsconfig.json', 'capture/address.ts', 'capture/pairing.ts', 'package.json', 'package-lock.json', '-x', '*/dist/*'], {
  cwd: path.join(here, '..'),
})
rmSync(compiled, { recursive: true, force: true })
for (const z of [...zips, src]) process.stdout.write(`${path.relative(process.cwd(), z)}\n`)
