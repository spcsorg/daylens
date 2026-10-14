#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

function fail(message) {
  throw new Error(`[packaged-natives] ${message}`)
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, results)
    } else if (entry.isFile() && entry.name === 'app.asar') {
      results.push(fullPath)
    }
  }
  return results
}

function verifyPackage(asarPath) {
  const resourcesDir = path.dirname(asarPath)
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const archiveEntry = (entry) => {
    try {
      return asar.statFile(asarPath, entry)
    } catch {
      fail(`${asarPath} is missing archive entry ${entry}`)
    }
  }
  const requireArchiveFile = (entry) => {
    const stat = archiveEntry(entry)
    if (stat.files || stat.link || !stat.size) {
      fail(`${asarPath} has an invalid or empty archive file ${entry}`)
    }
    if (stat.unpacked && !fs.existsSync(path.join(unpackedDir, entry))) {
      fail(`${asarPath} is missing unpacked archive file ${entry}`)
    }
    return stat
  }
  requireArchiveFile('package.json')
  const metadata = JSON.parse(asar.extractFile(asarPath, 'package.json').toString())
  if (metadata.main !== 'dist/main/main.js') {
    fail(
      `${asarPath} has unsupported main entry ${JSON.stringify(metadata.main)}; rebuild with npm run package`,
    )
  }
  for (const entry of [
    metadata.main,
    'dist/main/preload.js',
    'dist/renderer/main_window/index.html',
    'dist/mcp-server/index.cjs',
    'dist/range-worker/index.cjs',
    'dist/embed-worker/index.cjs',
    'dist/capture-relay/index.cjs',
  ]) {
    requireArchiveFile(entry)
  }
  const normalizationPath = path.join(resourcesDir, 'app-normalization.v1.json')
  if (!fs.existsSync(normalizationPath) || !fs.statSync(normalizationPath).size) {
    fail(`${asarPath} is missing the app-normalization.v1.json resource`)
  }
  const rendererPath = 'dist/renderer/main_window/index.html'
  const html = asar.extractFile(asarPath, rendererPath).toString()
  for (const match of html.matchAll(/(?:src|href)=["'](\.?\/?assets\/[^"']+)["']/g)) {
    requireArchiveFile(path.posix.join(path.posix.dirname(rendererPath), match[1]))
  }

  // All three native modules listed in asarUnpack must be present.
  // Missing any of them means the app will crash on launch.
  const requiredNativeBindings = [
    {
      name: 'better-sqlite3',
      binding: path.join(
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node',
      ),
    },
    {
      name: '@paymoapp/active-window',
      binding: path.join(
        'node_modules',
        '@paymoapp',
        'active-window',
        'build',
        'Release',
        'PaymoActiveWindow.node',
      ),
    },
    {
      name: 'keytar',
      binding: path.join('node_modules', 'keytar', 'build', 'Release', 'keytar.node'),
    },
  ]

  for (const { name, binding } of requiredNativeBindings) {
    const stat = requireArchiveFile(binding.split(path.sep).join('/'))
    if (!stat.unpacked) {
      fail(`${asarPath} must unpack the ${name} native binding`)
    }
    const fullPath = path.join(unpackedDir, binding)
    if (!fs.existsSync(fullPath)) {
      fail(
        `${path.relative(process.cwd(), asarPath)} is missing unpacked ${name} native binding at ${fullPath}`,
      )
    }
  }

  const requiredModuleEntries = [
    // better-sqlite3 and its transitive deps (loaded via `bindings` package)
    path.join('node_modules', 'better-sqlite3', 'package.json'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'index.js'),
    path.join('node_modules', 'better-sqlite3', 'lib', 'database.js'),
    path.join('node_modules', 'bindings', 'package.json'),
    path.join('node_modules', 'bindings', 'bindings.js'),
    path.join('node_modules', 'file-uri-to-path', 'package.json'),
    path.join('node_modules', 'file-uri-to-path', 'index.js'),
    // @paymoapp/active-window (loads .node via direct relative require)
    path.join('node_modules', '@paymoapp', 'active-window', 'package.json'),
    path.join('node_modules', '@paymoapp', 'active-window', 'dist', 'index.js'),
    // keytar (loads .node via direct relative require)
    path.join('node_modules', 'keytar', 'package.json'),
    path.join('node_modules', 'keytar', 'lib', 'keytar.js'),
  ]

  for (const entry of requiredModuleEntries) {
    requireArchiveFile(entry.split(path.sep).join('/'))
  }

  console.log(`[packaged-natives] ok ${path.relative(process.cwd(), asarPath)}`)
}

function verifyPackages(root) {
  const packages = walk(root)
  if (packages.length === 0) {
    fail(`No app.asar files found under ${root}`)
  }
  for (const asarPath of packages) {
    verifyPackage(asarPath)
  }
}

module.exports = { verifyPackage, verifyPackages }

if (require.main === module) {
  try {
    verifyPackages(process.argv[2] || path.join(process.cwd(), 'dist-release'))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
