import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const V2 = path.resolve(import.meta.dirname, '..', '..')

interface PackageRun {
  commands: { command: string; args: string[] }[]
  config: { extraResources: { from: string; to: string }[]; appx: Record<string, string> | null }
}

const IDENTITY = { DAYLENS_STORE_IDENTITY_NAME: 'Example.Daylens', DAYLENS_STORE_PUBLISHER: 'CN=Example', DAYLENS_STORE_PUBLISHER_DISPLAY_NAME: 'Example' }

// Run the build entry point, but intercept every command and filesystem effect so no native binary is changed or run.
function windowsPackage(testBuild: boolean, env: NodeJS.ProcessEnv = IDENTITY): PackageRun {
  const modules = {
    'node:child_process': `export function execFileSync(command, args) { globalThis.commands.push({ command, args }) }`,
    'node:fs': `
      const noop = () => {}
      export const chmodSync = noop, copyFileSync = noop, cpSync = noop, mkdirSync = noop, rmSync = noop, writeFileSync = noop
      export const existsSync = () => true
      export const readFileSync = file => file.endsWith('package.json') ? '{"version":"2.0.0-beta.1"}' : Buffer.from('ENABLE_DBPAGE_VTAB')
    `,
    'electron-builder': `
      export const Arch = { x64: 1, arm64: 3, universal: 4 }
      export const Platform = { WINDOWS: { createTarget: () => ({}) } }
      export async function build({ config }) { globalThis.packageConfig = config }
    `,
    './arm64.ts': `export function assertArm64() { throw new Error('Windows must not inspect a Mac bundle') }`,
    './localSigning.ts': `export function localIdentity() { throw new Error('Windows must not sign a Mac bundle') }`,
  }
  const script = `
    import { registerHooks } from 'node:module'
    const modules = ${JSON.stringify(modules)}
    globalThis.commands = []
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    process.argv = [process.execPath, ...${JSON.stringify(testBuild ? ['--test'] : [])}]
    registerHooks({
      resolve(s, c, next) { return Object.hasOwn(modules, s) ? { url: 'test:' + s, shortCircuit: true } : next(s, c) },
      load(u, c, next) { return u.startsWith('test:') ? { format: 'module', source: modules[u.slice(5)], shortCircuit: true } : next(u, c) }
    })
    await import(${JSON.stringify(pathToFileURL(path.join(V2, 'app', 'package', 'build.ts')).href)})
    console.log('PACKAGE_RUN ' + JSON.stringify({ commands, config: packageConfig }))
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAYLENS_STORE_'))), ...env }, stdio: 'pipe' })
  const result = output.split('\n').find(line => line.startsWith('PACKAGE_RUN '))
  assert.ok(result, output)
  return JSON.parse(result.slice('PACKAGE_RUN '.length)) as PackageRun
}

const packages = [false, true].map((testBuild) => windowsPackage(testBuild))

test('Windows release and test packages run Vite through its JavaScript entry point, never a shell shim', () => {
  for (const run of packages) {
    const vite = run.commands.find(c => c.args.includes('--config'))
    assert.ok(vite)
    assert.equal(vite.command, process.execPath)
    assert.deepEqual(vite.args, [path.join(V2, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(V2, 'app', 'vite.config.ts')])
  }
})

test('Windows release and test packages bundle native runtime libraries into the helper they ship alone', () => {
  for (const run of packages) {
    const publish = run.commands.find(c => c.command === 'dotnet')
    assert.ok(publish)
    assert.deepEqual(publish.args, ['publish', 'native/windows/Daylens.Capture.Windows', '-c', 'Release', '-r', 'win-x64', '-o', 'native/windows/publish', '-p:IncludeNativeLibrariesForSelfExtract=true'])
    assert.deepEqual(run.config.extraResources.filter(r => r.from.includes(path.join('native', 'windows'))), [{
      from: path.join(V2, 'native', 'windows', 'publish', 'daylens-capture-windows.exe'),
      to: 'daylens-capture-windows.exe',
    }])
  }
})

test('the Windows release is the Store package, named by the identity from the environment', () => {
  const appx = packages[0]!.config.appx!
  assert.equal(appx.identityName, 'Example.Daylens')
  assert.equal(appx.publisher, 'CN=Example')
  assert.equal(appx.publisherDisplayName, 'Example')
  assert.equal(packages[1]!.config.appx, null)
})

test('the Store package refuses to build without its identity, and names what is missing', () => {
  assert.throws(() => windowsPackage(false, { DAYLENS_STORE_PUBLISHER: 'CN=Example' }), /needs DAYLENS_STORE_IDENTITY_NAME, DAYLENS_STORE_PUBLISHER_DISPLAY_NAME/)
  assert.throws(() => windowsPackage(false, { ...IDENTITY, DAYLENS_STORE_PUBLISHER: 'Example' }), /whole CN=\.\.\. string/)
})
