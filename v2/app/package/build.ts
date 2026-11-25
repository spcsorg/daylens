// Builds macOS apps or the Windows x64 Store package (MSIX) into v2/build/release. Build on the target OS.
// Usage: node app/package/build.ts [--dir] [--test]
//   --dir stops at the app folder, without making archives.
//   --test builds this platform’s test app into v2/build/test, which honours the
//   test switches a release drops (DAYLENS_TEST_NOW, the data, shell and helper overrides; app/main/testEnv.ts) and
//   lets a debugger attach. checkRelease.ts proves the difference.
//
// DAYLENS_MAC_LOCAL_SIGN=1 signs with this Mac's self-signed identity (localSigning.ts), so the helper keeps its
// Accessibility grant from build to build; Gatekeeper still treats the app as unidentified.
//
// Signing is off unless DAYLENS_MAC_SIGN=1; without it the app is signed ad hoc, for this Mac only. With it, every
// variable below is required, and the app is signed with the keychain's Developer ID Application certificate for the
// team, then notarized and stapled:
//   APPLE_TEAM_ID      the 10-character Team ID
//   APPLE_API_KEY      path to the App Store Connect API key (AuthKey_<id>.p8)
//   APPLE_API_KEY_ID   the key's ID
//   APPLE_API_ISSUER   the key's issuer ID
//
// The Windows package takes its identity from Partner Center (docs/operations/windows-store.md), and every variable is required:
//   DAYLENS_STORE_IDENTITY_NAME            Package/Identity/Name
//   DAYLENS_STORE_PUBLISHER                Package/Identity/Publisher, the CN=... string
//   DAYLENS_STORE_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
// The Store signs what is uploaded, so the package is left unsigned. CSC_LINK and CSC_KEY_PASSWORD sign it with a
// certificate whose subject is DAYLENS_STORE_PUBLISHER, so it installs outside the Store (CI's test identity).
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Arch, Platform, build, type Configuration } from 'electron-builder'
import { assertArm64 } from './arm64.ts'
import { localIdentity, type LocalIdentity } from './localSigning.ts'

const { values } = parseArgs({ options: { dir: { type: 'boolean', default: false }, test: { type: 'boolean', default: false } } })
const TEST = values.test!
const WINDOWS = process.platform === 'win32'
if (!WINDOWS && process.platform !== 'darwin') throw new Error('packaging is supported on macOS and Windows only')
if (WINDOWS && process.arch !== 'x64') throw new Error('the Windows package currently supports x64 only')
const ARCH = WINDOWS ? Arch.x64 : TEST ? (process.arch === 'arm64' ? Arch.arm64 : Arch.x64) : Arch.universal
const V2 = path.resolve(import.meta.dirname, '..', '..')
const ROOT = path.join(V2, '..')
const PKG = import.meta.dirname
const OUT = path.join(V2, 'build')
const version = (JSON.parse(readFileSync(path.join(V2, 'package.json'), 'utf8')) as { version: string }).version
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: V2, stdio: 'inherit' })

function signing(): { teamId: string } | null {
  if (process.env.DAYLENS_MAC_SIGN !== '1') return null
  if (TEST) throw new Error('a test build is never signed for release')
  const missing = ['APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter((k) => !process.env[k])
  if (missing.length) throw new Error(`DAYLENS_MAC_SIGN=1 needs ${missing.join(', ')}`)
  const teamId = process.env.APPLE_TEAM_ID!
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APPLE_TEAM_ID is not a 10-character Team ID')
  if (!existsSync(process.env.APPLE_API_KEY!)) throw new Error('APPLE_API_KEY is not a file')
  return { teamId }
}

interface StoreIdentity {
  identityName: string
  publisher: string
  publisherDisplayName: string
}

function storeIdentity(): StoreIdentity {
  const names = ['DAYLENS_STORE_IDENTITY_NAME', 'DAYLENS_STORE_PUBLISHER', 'DAYLENS_STORE_PUBLISHER_DISPLAY_NAME']
  const missing = names.filter((k) => !process.env[k])
  if (missing.length) throw new Error(`the Store package needs ${missing.join(', ')}; Partner Center lists them under Product identity (docs/operations/windows-store.md)`)
  const store = { identityName: process.env.DAYLENS_STORE_IDENTITY_NAME!, publisher: process.env.DAYLENS_STORE_PUBLISHER!, publisherDisplayName: process.env.DAYLENS_STORE_PUBLISHER_DISPLAY_NAME! }
  if (!store.publisher.startsWith('CN=')) throw new Error('DAYLENS_STORE_PUBLISHER is the whole CN=... string from Partner Center')
  return store
}

const SQLITE = path.join(V2, 'node_modules', 'better-sqlite3')
const SQLITE_BINARY = path.join(SQLITE, 'build', 'Release', 'better_sqlite3.node')

// better-sqlite3 for both architectures (a test build: this one), each built with the option storage needs
// (tools/buildSqlite.ts), joined into one universal binary. The app ships only that one, where better-sqlite3 looks
// when it has no prebuilt binary: macOS flags any app holding an Intel-only binary, even one Apple silicon never loads.
function sqlite(): void {
  if (WINDOWS) {
    const file = path.join(SQLITE, 'prebuilds', 'win32-x64.node')
    if (!readFileSync(file).includes('ENABLE_DBPAGE_VTAB')) throw new Error('run npm run build:sqlite before packaging')
    mkdirSync(path.dirname(SQLITE_BINARY), { recursive: true })
    copyFileSync(file, SQLITE_BINARY)
    return
  }
  const builds = (TEST ? [process.arch] : ['arm64', 'x64']).map((arch) => {
    const file = path.join(SQLITE, 'prebuilds', `darwin-${arch}.node`)
    if (!readFileSync(file).includes('ENABLE_DBPAGE_VTAB')) run(process.execPath, [path.join(V2, 'tools', 'buildSqlite.ts'), '--arch', arch])
    return file
  })
  mkdirSync(path.dirname(SQLITE_BINARY), { recursive: true })
  run('lipo', ['-create', ...builds, '-output', SQLITE_BINARY])
}

function js(): void {
  rmSync(path.join(OUT, 'app'), { recursive: true, force: true })
  run(process.execPath, [path.join(V2, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(V2, 'app', 'vite.config.ts')])
  run(process.execPath, [path.join(V2, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(PKG, 'tsconfig.json')])
  mkdirSync(path.join(OUT, 'app', 'app', 'preload'), { recursive: true })
  copyFileSync(path.join(V2, 'app', 'preload', 'preload.cjs'), path.join(OUT, 'app', 'app', 'preload', 'preload.cjs'))
  cpSync(path.join(V2, 'app', 'renderer', 'dist'), path.join(OUT, 'app', 'app', 'renderer', 'dist'), { recursive: true })
}

// The capture helper as its own app bundle, named and drawn like Daylens, so System Settings › Accessibility shows it
// as Daylens. It is the process macOS grants window titles to.
function helper(): void {
  if (WINDOWS) {
    run('dotnet', ['publish', 'native/windows/Daylens.Capture.Windows', '-c', 'Release', '-r', 'win-x64', '-o', 'native/windows/publish', '-p:IncludeNativeLibrariesForSelfExtract=true'])
    return
  }
  const archs = TEST ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64']
  const swift = ['build', '-c', 'release', '--package-path', path.join(V2, 'native', 'macos'), ...archs.flatMap((a) => ['--arch', a])]
  run('swift', swift)
  const binDir = execFileSync('swift', [...swift, '--show-bin-path'], { cwd: V2, encoding: 'utf8' }).trim()
  const app = path.join(OUT, 'helper', 'Daylens.app', 'Contents')
  rmSync(path.join(OUT, 'helper'), { recursive: true, force: true })
  mkdirSync(path.join(app, 'MacOS'), { recursive: true })
  mkdirSync(path.join(app, 'Resources'), { recursive: true })
  copyFileSync(path.join(binDir, 'daylens-capture-macos'), path.join(app, 'MacOS', 'daylens-capture-macos'))
  chmodSync(path.join(app, 'MacOS', 'daylens-capture-macos'), 0o755)
  copyFileSync(path.join(ROOT, 'build', 'icon.icns'), path.join(app, 'Resources', 'icon.icns'))
  const keys: Record<string, string | boolean> = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: 'Daylens',
    CFBundleExecutable: 'daylens-capture-macos',
    CFBundleIconFile: 'icon',
    CFBundleIdentifier: 'com.daylens.desktop.capture',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'Daylens',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: '13.0',
    LSUIElement: true,
  }
  const body = Object.entries(keys)
    .map(([k, v]) => `  <key>${k}</key>\n  ${typeof v === 'boolean' ? `<${v}/>` : `<string>${v}</string>`}`)
    .join('\n')
  writeFileSync(
    path.join(app, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`,
  )
  run('plutil', ['-lint', path.join(app, 'Info.plist')])
}

function config(sign: { teamId: string } | null, local: LocalIdentity | null, store: StoreIdentity | null): Configuration {
  const helperPath = 'Contents/Helpers/Daylens.app'
  return {
    appId: 'com.daylens.desktop',
    productName: 'Daylens',
    copyright: 'Copyright © 2026 Daylens',
    directories: { output: path.join(OUT, TEST ? 'test' : 'release'), buildResources: PKG },
    files: [
      'package.json',
      'build/app/**/*',
      '!node_modules/{react,react-dom,scheduler}/**',
      '!node_modules/better-sqlite3/{deps,src,prebuilds}/**',
      '!node_modules/better-sqlite3/build/**',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      '!node_modules/better-sqlite3/binding.gyp',
      '!node_modules/node-addon-api/**',
    ],
    // A separate name keeps electron-updater's cache apart from V1's.
    extraMetadata: { name: 'daylens-v2', main: 'build/app/app/main/main.js', ...(TEST && { daylensTestBuild: true }) },
    asar: true,
    asarUnpack: ['node_modules/better-sqlite3/build/Release/better_sqlite3.node'],
    npmRebuild: false,
    // The default Windows kit's signtool predates MSIX and cannot sign one.
    toolsets: { winCodeSign: '1.1.0' },
    electronFuses: {
      // The MCP server runs as Node in this binary. Safe only while the main app holds no macOS privacy permission.
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      // A test build lets Playwright attach to the main process.
      enableNodeCliInspectArguments: TEST,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    extraResources: [
      { from: path.join(ROOT, 'build', 'trayTemplate.png'), to: 'trayTemplate.png' },
      { from: path.join(ROOT, 'build', 'trayTemplate@2x.png'), to: 'trayTemplate@2x.png' },
      { from: path.join(ROOT, 'build', 'icon.png'), to: 'icon.png' },
      ...(WINDOWS ? [{ from: path.join(V2, 'native', 'windows', 'publish', 'daylens-capture-windows.exe'), to: 'daylens-capture-windows.exe' }] : []),
    ],
    extraFiles: WINDOWS ? [] : [{ from: path.join(OUT, 'helper', 'Daylens.app'), to: 'Helpers/Daylens.app' }],
    win: {
      icon: path.join(ROOT, 'build', 'icon.png'),
      requestedExecutionLevel: 'asInvoker',
      // A package carries one signature, so it cannot take the default SHA-1 and SHA-256 pair.
      signtoolOptions: { signingHashAlgorithms: ['sha256'] },
    },
    // The logos are in appx/, drawn from build/icon.png by appx.py.
    appx: store && {
      ...store,
      // Start's shell:AppsFolder\<family>!Daylens; Partner Center's identity name can begin with digits, which an Id can't.
      applicationId: 'Daylens',
      customManifestPath: 'appxmanifest.xml',
      artifactName: 'Daylens-${version}-win-x64.msix',
      backgroundColor: 'transparent',
      languages: ['en-US'],
      minVersion: '10.0.17763.0',
      maxVersionTested: '10.0.26100.0',
    },
    mac: {
      icon: path.join(ROOT, 'build', 'icon.icns'),
      category: 'public.app-category.productivity',
      minimumSystemVersion: '13.0',
      artifactName: 'Daylens-${version}-mac.${ext}',
      // The helper and better-sqlite3 are already universal; the merge keeps them as they are.
      x64ArchFiles: `{${helperPath}/Contents/MacOS/daylens-capture-macos,Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node}`,
      identity: sign ? `(${sign.teamId})` : '-',
      // Ad-hoc and self-signed code have no team, so the hardened runtime's library validation would refuse Electron's own framework.
      hardenedRuntime: Boolean(sign),
      notarize: Boolean(sign),
      entitlements: path.join(PKG, 'entitlements.mac.plist'),
      entitlementsInherit: path.join(PKG, 'entitlements.mac.plist'),
      sign: async (opts) => {
        const { sign: osxSign } = await import('app-builder-lib/out/codeSign/macCodeSign.js')
        const forFile = opts.optionsForFile!
        await osxSign({
          ...opts,
          ...(local && { identity: local.hash, identityValidation: false, keychain: local.keychain }),
          optionsForFile: (file: string) => ({
            ...forFile(file),
            ...(file.includes(`/${helperPath}`) && { entitlements: path.join(PKG, 'entitlements.none.plist') }),
            // A timestamp proves when a trusted signature was made; a self-signed one gains nothing from Apple's server.
            ...(local && { timestamp: 'none' }),
          }),
        })
      },
    },
    dmg: {
      // dmg-background@2x.png beside it is picked up for Retina, and the window takes the image's size; rebuild both
      // with dmg-background.cjs.
      background: path.join(PKG, 'dmg-background.png'),
      icon: path.join(ROOT, 'build', 'icon.icns'),
      iconSize: 128,
      title: 'Daylens ${version}',
      contents: [
        { x: 180, y: 205, type: 'file' },
        { x: 480, y: 205, type: 'link', path: '/Applications' },
      ],
    },
    // Signed and checked before the DMG and ZIP are made from it.
    afterSign: (ctx) => {
      if (ctx.arch === Arch.universal) assertArm64(path.join(ctx.appOutDir, 'Daylens.app'))
    },
    publish: { provider: 'github', owner: 'spcsorg', repo: 'daylens', releaseType: 'prerelease' },
  }
}

const DIR = values.dir || TEST
const sign = WINDOWS ? null : signing()
const store = WINDOWS && !DIR ? storeIdentity() : null
const local = !WINDOWS && !sign && process.env.DAYLENS_MAC_LOCAL_SIGN === '1' ? localIdentity() : null
sqlite()
js()
helper()
// A test build stops at the app folder; it is never a release artifact.
await build({ projectDir: V2, targets: (WINDOWS ? Platform.WINDOWS : Platform.MAC).createTarget(DIR ? ['dir'] : WINDOWS ? ['appx'] : ['dmg', 'zip'], ARCH), config: config(sign, local, store), publish: 'never' })

if (WINDOWS) {
  const out = path.join(OUT, TEST ? 'test' : 'release')
  process.stdout.write(store ? `${path.join(out, `Daylens-${version}-win-x64.msix`)}\n${process.env.CSC_LINK ? `signed as ${store.publisher}` : 'unsigned, for the Store to sign'}\n` : `${path.join(out, 'win-unpacked', 'Daylens.exe')}\n`)
} else {
  const app = path.join(OUT, TEST ? 'test' : 'release', ARCH === Arch.x64 ? 'mac' : `mac-${Arch[ARCH]}`, 'Daylens.app')
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  if (sign) {
    run('xcrun', ['stapler', 'validate', app])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  }
  process.stdout.write(`${app}\n${sign ? `signed for team ${sign.teamId}, notarized` : local ? `signed with local identity ${local.hash}` : 'signed ad hoc: opens on this Mac only'}\n`)
}
