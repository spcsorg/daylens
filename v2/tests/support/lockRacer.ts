// Waits for a shared start signal, then tries to open a Store; prints whether it got the writer lock.
import { existsSync } from 'node:fs'
import { Store } from '../../capture/store.ts'

const [dir, go] = process.argv.slice(2) as [string, string]
while (!existsSync(go)) {}
try {
  const s = new Store(dir)
  process.stdout.write('locked\n')
  setTimeout(() => {
    s.close()
    process.exit(0)
  }, 1500)
} catch (err) {
  process.stdout.write(/another capture service/.test(String(err)) ? 'refused\n' : `error ${String(err)}\n`)
  process.exit(0)
}
