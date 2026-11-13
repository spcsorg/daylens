// Writes (or removes) the native messaging host manifest for the dev build, in the folder a browser reads it from.
// Chromium browsers read <user data dir>/NativeMessagingHosts, so a test profile keeps a real profile untouched.
// Firefox on macOS reads only ~/Library/Application Support/Mozilla/NativeMessagingHosts.
// Usage: node browser/tools/register.ts --kind chromium|firefox --dir <folder> --host <helper binary> [--remove]
import { parseArgs } from 'node:util'
import { register, unregister } from '../../capture/browserHosts.ts'

if (import.meta.main) {
  const { values } = parseArgs({ options: { kind: { type: 'string' }, dir: { type: 'string' }, host: { type: 'string' }, remove: { type: 'boolean', default: false } } })
  if (values.remove) unregister(values.dir!)
  else process.stdout.write(register(values.kind as 'chromium' | 'firefox', values.dir!, values.host!) + '\n')
}
