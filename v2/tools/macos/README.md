# Running the engine every day on macOS

To run the engine every day on your Mac, copy the plist to `~/Library/LaunchAgents` and load it once. From then on, launchd starts the engine when you log in and restarts it if it stops unexpectedly. The engine records the apps, windows and pages you use, and reads your Claude Code and Codex session logs.

## Run it once by hand

From `v2`:

```bash
npm ci && npm run build:sqlite
(cd native/macos && swift build -c release)
node capture/service.ts --helper native/macos/.build/release/daylens-capture-macos --agent-sessions
```

`npm run build:sqlite` rebuilds better-sqlite3 so that deletion can zero deleted text left inside database pages. Without it, the engine still records, logs `storage error code=scrub_unavailable` at start, and never reports a deletion as purged. Run it again after every `npm ci` or `npm install`.

Stop the engine with Ctrl+C. It writes to `~/Library/Application Support/Daylens V2 Dev`, or to `--data-dir <dir>` if you pass one.

## Install it as a login item

1. Build as above (`npm ci`, `npm run build:sqlite`, `swift build -c release`).
2. Write the plist for this checkout. It points at the `node` you run it with, this folder, and the helper you just built:

   ```bash
   node tools/macos/launchd.ts
   ```

   It prints the path of the plist it wrote, `build/app.daylens.engine.plist`. Pass `--data-dir <dir>` to use another data folder, or `--node <path>` for another Node 24.
3. Copy it and load it:

   ```bash
   cp build/app.daylens.engine.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.daylens.engine.plist
   ```

4. Give it window-title access. The helper checks for Accessibility access but does not ask for it, so window titles stay empty until you allow it. Open System Settings › Privacy & Security › Accessibility and turn on the program macOS lists for the engine. Under launchd that is expected to be `node` from the plist, which gives every script run by that `node` the same access. If no entry appears, add that `node` with the + button. Then restart the engine (below).

## Day to day

- Logs: `~/Library/Logs/Daylens V2 Dev/engine.log`.
- Is it running: `launchctl print gui/$(id -u)/app.daylens.engine | grep -E 'state|pid'`.
- Restart, for example after pulling and rebuilding: `launchctl kickstart -k gui/$(id -u)/app.daylens.engine`.
- Stop it and remove it from login: `launchctl bootout gui/$(id -u)/app.daylens.engine`, then delete `~/Library/LaunchAgents/app.daylens.engine.plist`.

If you move this checkout or change Node versions, write and copy the plist again, then `bootout` and `bootstrap` it.
