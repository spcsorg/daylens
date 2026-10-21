// Rebuilds better-sqlite3's bundled SQLite (same version) with SQLITE_ENABLE_DBPAGE_VTAB, which storage needs to zero
// deleted text left in free space inside database pages (storage/scrub.ts). Storage refuses to mark a deletion purged
// on a build without it.
//
// Usage: node tools/buildSqlite.ts [--modules <node_modules dir>]   (default: this package's node_modules)
//        npm run build:sqlite
//
// Run it after every `npm install` or `npm ci`, and before packaging the app: it replaces the host platform's prebuilt
// binary in better-sqlite3/prebuilds, which both Node and Electron load (the addon uses Node-API, so one binary serves
// both), and Electron's rebuild step leaves a package with a prebuilt binary alone. It builds for the host platform and
// architecture only; package each platform on that platform. It needs node-gyp's toolchain (Xcode command line tools
// on macOS, Visual Studio Build Tools on Windows) and changes nothing outside the better-sqlite3 folder it is given.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const DEFINE = 'SQLITE_ENABLE_DBPAGE_VTAB'
const { values } = parseArgs({ options: { modules: { type: 'string' } } })
const modules = path.resolve(values.modules ?? path.join(import.meta.dirname, '..', 'node_modules'))
const pkg = path.join(modules, 'better-sqlite3')
if (!existsSync(path.join(pkg, 'package.json'))) throw new Error(`better-sqlite3 not found in ${modules}`)

const header = readFileSync(path.join(pkg, 'deps', 'sqlite3', 'sqlite3.h'), 'utf8')
const version = /#define SQLITE_VERSION\s+"([^"]+)"/.exec(header)?.[1]
if (!version) throw new Error('cannot read the bundled SQLite version')

const definesFile = path.join(pkg, 'deps', 'defines.gypi')
const defines = readFileSync(definesFile, 'utf8')
if (!defines.includes(`'${DEFINE}'`)) {
  const anchor = `'SQLITE_ENABLE_DBSTAT_VTAB',`
  if (!defines.includes(anchor)) throw new Error(`unexpected ${definesFile}: ${anchor} not found`)
  writeFileSync(definesFile, defines.replace(anchor, `${anchor}\n    '${DEFINE}',`))
}

function nodeGyp(): string {
  const candidates = [
    process.env.npm_config_node_gyp,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  ]
  const found = candidates.find((c): c is string => typeof c === 'string' && existsSync(c))
  if (!found) throw new Error('node-gyp not found; run through npm (npm run build:sqlite)')
  return found
}

execFileSync(process.execPath, [nodeGyp(), 'rebuild', '--release', '--force_build=1'], { cwd: pkg, stdio: 'inherit' })

const musl = process.platform === 'linux' && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime
const target = `${musl ? 'linuxmusl' : process.platform}-${process.arch}`
copyFileSync(path.join(pkg, 'build', 'Release', 'better_sqlite3.node'), path.join(pkg, 'prebuilds', `${target}.node`))

// A fresh process loads the binary the package will load from now on.
const check = execFileSync(
  process.execPath,
  ['-e', `const D = require(${JSON.stringify(pkg)}); const db = new D(':memory:'); db.prepare('SELECT count(*) FROM sqlite_dbpage').get(); process.stdout.write(db.prepare('SELECT sqlite_version() AS v').get().v)`],
  { encoding: 'utf8' },
)
if (check !== version) throw new Error(`built SQLite ${check}, expected the bundled ${version}`)
process.stdout.write(`better-sqlite3 ${target}: SQLite ${version} with ${DEFINE}\n`)
