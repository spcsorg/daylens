import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_FILE } from '../capture/store.ts'
import { Reader } from '../app/reader/queries.ts'
import { openReadOnly } from '../retrieval/reader.ts'
import { close, launch } from './daylens.ts'

test.skip(process.platform === 'win32', 'the isolated stand-in helper cannot launch on Windows yet [O-18]')

test('without a helper the actual utility process initializes an empty readable store and refuses recording', async () => {
  const d = await launch({ world: 'empty' })
  try {
    const data = path.join(d.world.root, 'without-helper')
    const state = await d.app.evaluate(async ({ app }, input) => {
      const path = process.getBuiltinModule('node:path')!
      const { createRequire } = process.getBuiltinModule('node:module')!
      const module = app.isPackaged ? path.join(app.getAppPath(), 'build/app/app/main/capture.js') : input.module
      const service = app.isPackaged ? path.join(app.getAppPath(), 'build/app/capture/service.js') : input.service
      const { Capture } = createRequire(module)(module)
      const capture = new Capture({ helper: null, service, dataDir: input.data, log: () => {} })
      ;(globalThis as { noHelperCapture?: { stop(): Promise<void> } }).noHelperCapture = capture
      capture.start()
      return { state: capture.state, error: capture.error, reply: await capture.request({ op: 'pause' }) }
    }, { data, module: fileURLToPath(new URL('../app/main/capture.ts', import.meta.url)), service: fileURLToPath(new URL('../capture/service.ts', import.meta.url)) })
    expect(state).toMatchObject({ state: 'failed', error: 'no_helper', reply: { ok: false, error: 'no_helper' } })
    await expect.poll(() => {
      const file = path.join(data, DB_FILE)
      if (!existsSync(file)) return false
      let db: ReturnType<typeof openReadOnly> | undefined
      try {
        db = openReadOnly(file)
        const reader = new Reader(db)
        return Array.isArray(reader.day('2031-03-04').hours) && reader.recording() !== null
      } catch {
        return false
      } finally {
        db?.close()
      }
    }).toBe(true)
  } finally {
    await d.app.evaluate(async () => (globalThis as { noHelperCapture?: { stop(): Promise<void> } }).noHelperCapture?.stop())
    await close(d)
  }
})
