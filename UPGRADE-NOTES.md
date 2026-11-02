# Electron upgrade: 44.5.1 → 45.2.1

## Versions

| | Before | After |
|---|---|---|
| Electron | 44.5.1 | **45.2.1** (latest stable, 30 Oct 2026) |
| Node (bundled) | 24.21.0 | **24.22.1** |
| Chromium | 152.0.7977.130 | 156.0.8078.75 |
| V8 | 15.2 | 15.6.75.25 |
| Node module ABI | 149 | 150 (no effect: better-sqlite3 uses Node-API) |
| electron-builder | 26.18.0 | 26.18.0 (already latest) |
| electron-updater | 6.8.11 | 6.8.11 (already latest) |
| `engines.node` / CI Node | `>=24` / 24 | unchanged |

The brief said Electron 34. V2 was already on 44.5.1. Electron 34 is **V1** (`docs/system-design.md`: "V1's 34 is out of support").

## Node2Shell (CVE-2026-111497)

- Node fixed it in 22.23.4, 24.22.1 and 26.12.1 (21 Oct 2026) by cherry-picking Brotli commit `0ed4268a` into `deps/brotli` and exposing `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH`. Node 20 gets no fix.
- Electron does not build Node with `deps/brotli`. Its Node GN patch (`patches/node/build_add_gn_build_files.patch`) links Chromium's `//third_party/brotli`.
- Chromium 152 (Electron 44.5.1) and 156 (Electron 45.2.1) both ship Brotli `cfa184a9` (18 Mar 2026), and that revision already contains `0ed4268a`. So the decoder V2 actually runs was already patched on 44.5.1.
- 45.2.1 also has Node's side of the fix: `zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` is `-17` under `ELECTRON_RUN_AS_NODE`.
- Why upgrade anyway: Node 24.22.1 carries six other CVE fixes (http, dns, tls ×2, permission, crypto), and scanners like Defender key on the Node version string. 24.21.0 reads as vulnerable; 24.22.1 does not.
- `process.versions.brotli` still says `1.2.0`. Node's fix doesn't bump that string, so a scanner reading it will keep flagging every patched runtime.
- **V1 is exposed.** Electron 34.5.8 ships Node 20.19.1 and Chromium 132. Both predate the fix and get no backport. This branch does nothing for V1 installs.

## Breaking changes (44 → 45) checked against the code

| Change in 45 | Daylens | Action |
|---|---|---|
| Sandboxed preloads lose `Buffer`, `events`, `timers`, `url`, `setImmediate` | `app/preload/preload.cjs` uses only `contextBridge`, `ipcRenderer`, `process.platform` | none |
| `ipcRenderer`/`process` in sandboxed preloads use native `EventEmitter` (no static `once`/`listenerCount`/`init`) | uses `on`, `removeListener`, `invoke` | none |
| Workers from subframes need `nodeIntegrationInSubFrames` | no subframes and no renderer workers; `worker_threads` run in the main and capture processes | none |
| `fs.open` on ASAR entries returns an fs-only descriptor | no raw-fd use; better-sqlite3 loads from `app.asar.unpacked` | none, but check in the packaged build (below) |
| `window.open` children of unsandboxed windows | windows are sandboxed and `setWindowOpenHandler` denies | none |
| `getUserMedia` desktop, `contentTracing`, `display-capture` permission, `requestStorageAccessFor` | not used | none |
| `safeStorage.isEncryptionAvailable/encryptString/decryptString` deprecated (removed in 46) | `app/main/ipc/ai.ts` → `retrieval/apiKey.ts` use the sync calls | left alone: only a deprecation warning in 45. **Moving to the async API is required before Electron 46.** |

Code change: `tests/agents/memory.test.ts` asserted the Electron version literally, so it now says `45.2.1`.

Also coming in 46 and worth knowing: `--experimental-transform-types` is removed (`npm run app` runs `electron app/main/main.ts` on plain type stripping, so it's unaffected), and `utilityProcess.kill()` no longer escalates to `SIGKILL` (the reader and capture run as utility processes).

## Test results (macOS arm64, this machine)

| Check | Result |
|---|---|
| `npm run build:sqlite` | pass (SQLite 3.53.4 with `SQLITE_ENABLE_DBPAGE_VTAB`) |
| `npm run typecheck` | pass |
| `npm run app:typecheck` | pass |
| `npm test` | **pass**: 827 tests, 817 pass, 0 fail, 10 skipped. All 10 skips are the real macOS helper not being built, unrelated to Electron. The 135 MB memory test ran under Electron 45.2.1 Node mode and passed. |
| `npm run contract:check` | no such script in the repo; nothing to run |

App smoke test with `npm run demo` (invented pricing world, throwaway folder): Today, Week, Apps, Ask and Settings → AI all render on Chromium 156. Capture, the browser socket and the stand-in helper start and stop cleanly (0 crashes, 0 lines lost). No errors or deprecation warnings were logged while running. Killing the app with SIGTERM printed two "Render frame was disposed before WebFrameMain could be accessed" warnings, which are harmless on a forced quit. Chrome and Zoom have no icon only because neither app is installed on this Mac, which is by design.

Budgets (`app/tools/bench.ts`, 5 runs each, same machine, back to back, under heavy load from other work: load average 9–29):

| Measure (median / max, ms) | 44.5.1 | 45.2.1 | Budget |
|---|---|---|---|
| Launch to Today on screen | 794 / 1288 | 621 / 1409 | < 2000 |
| Renderer to Today painted | 161 / 195 | 183 / 241 | < 200 first paint |
| Switch day | 17 / 1153 | 32 / 68 | < 100 |
| Week view | 10 / 679 | 17 / 35 | < 200 |
| Month view | 12 / 223 | 14 / 298 | < 200 |
| Search | 3 / 7 | 2 / 7 | < 100 |

No regression stands out of the noise. Both versions show load spikes in their max column. The first bench attempt on 45.2.1 timed out once (the binary's first launch after download, under load) and left a capture process holding the folder lock. The later runs were clean. Budgets still need measuring from signed, packaged builds on every platform before release.

## Windows checklist

CI runs the tests on `windows-latest` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, so the Electron binary itself never runs there. Check by hand on the Windows laptop:

1. `npm ci`, `npm run build:sqlite`, `npm test` on the branch. better-sqlite3 rebuilds under MSVC and loads in Electron 45.
2. `npm run app`: the window paints, Today shows, and the tray icon and menu work.
3. Capture: the capture utility process and the Windows helper start, events arrive, and quitting Daylens stops both (nothing left behind in Task Manager).
4. Settings → AI key: save, quit, relaunch, and the key still loads. This is DPAPI via `safeStorage`; note any deprecation warning in the console.
5. Ask and Search over the MessagePort reader: results appear and switching days stays under 100 ms.
6. `npm run app:package`, then install the MSIX/Store package. Launch at login (startup task), the auto-updater check and the MCP server under `ELECTRON_RUN_AS_NODE` (`resources\app.asar\build\app\mcp\main.js`) all work. The MCP server is where the new ASAR fd rules would bite.
7. Defender: scan the installed package and confirm Node2Shell is no longer reported.
8. The deletion flow (Settings → delete history) finishes. It uses a `worker_threads` Worker loaded from inside the asar.

Linux: CI covers the tests; the packaged AppImage/nightly and the keyring backend check in `apiKey.ts` need a manual run.

## Launch risk

- **Low for V2.** The diff is the Electron pin, the lockfile and one test literal. No API in the 45 breaking-change list is used.
- **Not yet proven from a signed, packaged build** on any platform. The release checklist asks for budgets from packaged builds, and the new ASAR descriptor rules only show up there (MCP server, deletion worker, backfill worker).
- **Chromium 152 → 156** can shift rendering. Screens were checked on invented data on macOS only.
- **The flagged devices were most likely on V1** (Electron 34 / Node 20). Shipping V2 on 45.2.1 does not clear them. Only moving those users to V2, or retiring V1, does.
