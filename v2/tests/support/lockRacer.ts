// Says it's ready, waits for the start signal, tries to open a Store, and prints whether it got the writer lock.
// A winner holds the lock until the release signal, so a racer that starts late can only be refused.
import { existsSync } from 'node:fs'
import { Store } from '../../capture/store.ts'

const [dir, go, release] = process.argv.slice(2) as [string, string, string]
process.stdout.write('ready\n')
while (!existsSync(go)) {}
try {
  const s = new Store(dir)
  process.stdout.write('locked\n')
  const poll = setInterval(() => {
    if (!existsSync(release)) return
    clearInterval(poll)
    s.close()
    process.exit(0)
  }, 10)
} catch (err) {
  process.stdout.write(/another capture service/.test(String(err)) ? 'refused\n' : `error ${String(err)}\n`)
  process.exit(0)
}
