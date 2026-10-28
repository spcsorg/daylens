import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDistroList, WslDiscovery } from '../../capture/agents/wsl.ts'

const utf16 = (s: string, bom = false) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])

test('the running-distribution list is read in the encodings wsl.exe writes', () => {
  assert.deepEqual(parseDistroList(utf16('Ubuntu-24.04\r\nDebian\r\n')), ['Ubuntu-24.04', 'Debian'])
  assert.deepEqual(parseDistroList(utf16('Ubuntu\r\n', true)), ['Ubuntu'])
  assert.deepEqual(parseDistroList(Buffer.from('Ubuntu\nkali-linux\n')), ['Ubuntu', 'kali-linux'])
  assert.deepEqual(parseDistroList(utf16('')), [])
})

test('only running distributions are ever touched, and their roots become unavailable when they stop', async () => {
  let running = 'Ubuntu\r\n'
  const touched: string[] = []
  const d = new WslDiscovery(
    async () => utf16(running),
    async (dir) => {
      touched.push(dir)
      return ['me']
    },
  )
  const roots = await d.discover()
  assert.ok(touched.every((t) => t.includes('\\Ubuntu\\')), 'a stopped distribution is never listed')
  assert.deepEqual(
    roots.map((r) => r.dir),
    [
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects',
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions',
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\archived_sessions',
      '\\\\wsl.localhost\\Ubuntu\\root\\.claude\\projects',
      '\\\\wsl.localhost\\Ubuntu\\root\\.codex\\sessions',
      '\\\\wsl.localhost\\Ubuntu\\root\\.codex\\archived_sessions',
    ],
  )
  assert.ok(roots.every((r) => r.poll === true && r.available!()))
  running = ''
  assert.deepEqual(await d.discover(), [])
  assert.ok(roots.every((r) => !r.available!()), 'once stopped, the reader leaves it alone')
  // When wsl.exe cannot be run, nothing is assumed to be running.
  const none = new WslDiscovery(async () => null, async () => assert.fail('must not list anything'))
  assert.deepEqual(await none.discover(), [])
})
