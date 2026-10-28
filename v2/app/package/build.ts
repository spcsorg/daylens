// Builds the universal macOS app and its DMG and update ZIP into v2/build/release.
// Usage: node app/package/build.ts [--dir]   (--dir stops at the .app, without the DMG and ZIP)
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
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Arch, Platform, build, type Configuration } from 'electron-builder'
import { assertArm64 } from './arm64.ts'
import { localIdentity, type LocalIdentity } from './localSigning.ts'

const { values } = parseArgs({ options: { dir: { type: 'boolean', default: false } } })
const V2 = path.resolve(import.meta.dirname, '..', '..')
const ROOT = path.join(V2, '..')
const PKG = import.meta.dirname
const OUT = path.join(V2, 'build')
const version = (JSON.parse(readFileSync(path.join(V2, 'package.json'), 'utf8')) as { version: string }).version
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: V2, stdio: 'inherit' })
const bin = (name: string) => path.join(V2, 'node_modules', '.bin', name)

function signing(): { teamId: string } | null {
  if (process.env.DAYLENS_MAC_SIGN !== '1') return null
  const missing = ['APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter((k) => !process.env[k])
  if (missing.length) throw new Error(`DAYLENS_MAC_SIGN=1 needs ${missing.join(', ')}`)
  const teamId = process.env.APPLE_TEAM_ID!
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('APPLE_TEAM_ID is not a 10-character Team ID')
  if (!existsSync(process.env.APPLE_API_KEY!)) throw new Error('APPLE_API_KEY is not a file')
  return { teamId }
}

const SQLITE = path.join(V2, 'node_modules', 'better-sqlite3')
const SQLITE_UNIVERSAL = path.join(SQLITE, 'build', 'Release', 'better_sqlite3.node')

// better-sqlite3 for both architectures, each built with the option storage needs (tools/buildSqlite.ts), joined into
// one universal binary. The app ships only that one, where better-sqlite3 looks when it has no prebuilt binary: macOS
// flags any app holding an Intel-only binary, even one Apple silicon never loads.
function sqlite(): void {
  const builds = ['arm64', 'x64'].map((arch) => {
    const file = path.join(SQLITE, 'prebuilds', `darwin-${arch}.node`)
    if (!readFileSync(file).includes('ENABLE_DBPAGE_VTAB')) run(process.execPath, [path.join(V2, 'tools', 'buildSqlite.ts'), '--arch', arch])
    return file
  })
  mkdirSync(path.dirname(SQLITE_UNIVERSAL), { recursive: true })
  run('lipo', ['-create', ...builds, '-output', SQLITE_UNIVERSAL])
}

function js(): void {
  rmSync(path.join(OUT, 'app'), { recursive: true, force: true })
  run(process.execPath, [bin('vite'), 'build', '--config', path.join(V2, 'app', 'vite.config.ts')])
  run(process.execPath, [path.join(V2, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(PKG, 'tsconfig.json')])
  mkdirSync(path.join(OUT, 'app', 'app', 'preload'), { recursive: true })
  copyFileSync(path.join(V2, 'app', 'preload', 'preload.cjs'), path.join(OUT, 'app', 'app', 'preload', 'preload.cjs'))
  cpSync(path.join(V2, 'app', 'renderer', 'dist'), path.join(OUT, 'app', 'app', 'renderer', 'dist'), { recursive: true })
}

// The capture helper as its own app bundle, named and drawn like Daylens, so System Settings › Accessibility shows it
// as Daylens. It is the process macOS grants window titles to.
function helper(): void {
  const swift = ['build', '-c', 'release', '--package-path', path.join(V2, 'native', 'macos'), '--arch', 'arm64', '--arch', 'x86_64']
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

function config(sign: { teamId: string } | null, local: LocalIdentity | null): Configuration {
  const helperPath = 'Contents/Helpers/Daylens.app'
  return {
    appId: 'com.daylens.desktop',
    productName: 'Daylens',
    copyright: 'Copyright © 2026 Daylens',
    directories: { output: path.join(OUT, 'release'), buildResources: PKG },
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
    extraMetadata: { name: 'daylens-v2', main: 'build/app/app/main/main.js' },
    asar: true,
    asarUnpack: ['node_modules/better-sqlite3/build/Release/better_sqlite3.node'],
    npmRebuild: false,
    electronFuses: {
      // The MCP server runs as Node in this binary. Safe only while the main app holds no macOS privacy permission.
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    extraResources: [
      { from: path.join(ROOT, 'build', 'trayTemplate.png'), to: 'trayTemplate.png' },
      { from: path.join(ROOT, 'build', 'trayTemplate@2x.png'), to: 'trayTemplate@2x.png' },
      { from: path.join(ROOT, 'build', 'icon.png'), to: 'icon.png' },
    ],
    extraFiles: [{ from: path.join(OUT, 'helper', 'Daylens.app'), to: 'Helpers/Daylens.app' }],
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
      background: path.join(ROOT, 'build', 'dmg-background.png'),
      icon: path.join(ROOT, 'build', 'icon.icns'),
      iconSize: 128,
      window: { width: 660, height: 480 },
      contents: [
        { x: 180, y: 225, type: 'file' },
        { x: 480, y: 225, type: 'link', path: '/Applications' },
      ],
    },
    // Signed and checked before the DMG and ZIP are made from it.
    afterSign: (ctx) => {
      if (ctx.arch === Arch.universal) assertArm64(path.join(ctx.appOutDir, 'Daylens.app'))
    },
    publish: { provider: 'github', owner: 'spcsorg', repo: 'daylens', releaseType: 'prerelease' },
  }
}

const sign = signing()
const local = !sign && process.env.DAYLENS_MAC_LOCAL_SIGN === '1' ? localIdentity() : null
sqlite()
js()
helper()
await build({ projectDir: V2, targets: Platform.MAC.createTarget(values.dir ? ['dir'] : ['dmg', 'zip'], Arch.universal), config: config(sign, local), publish: 'never' })

const app = path.join(OUT, 'release', 'mac-universal', 'Daylens.app')
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
if (sign) {
  run('xcrun', ['stapler', 'validate', app])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
}
process.stdout.write(`${app}\n${sign ? `signed for team ${sign.teamId}, notarized` : local ? `signed with local identity ${local.hash}` : 'signed ad hoc: opens on this Mac only'}\n`)
