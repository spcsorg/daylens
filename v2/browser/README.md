# Daylens browser extension

This folder holds the Daylens extension for Chrome, Edge, Arc, Dia and Firefox, its build, its store texts and its
live tests. The extension tells the capture service which page is in front: only the focused tab of a focused normal
window, and "unknown" for everything else. The wire format and both transports are specified in
[PROTOCOL.md](../protocol/PROTOCOL.md#browser-host).

## Layout

| Path | Contents |
|---|---|
| `extension/src/focus.ts` | The decision: which tab counts as a page, and when to say unknown. Pure, unit-tested in `tests/extension.test.ts`. |
| `extension/src/background.ts` | Browser listeners, the native messaging port, the local connection fallback, the browser-only pause. |
| `extension/src/local.ts` | The extension's side of the local connection: tries each port, checks the service's proof before sending its own. |
| `extension/src/popup.*` | The popup: status, one pause button with three durations, Connect, Open Daylens. |
| `extension/src/kv.ts` | Pairing and pause kept in the extension's IndexedDB, which needs no `storage` permission. |
| `extension/manifest.*.json` | Chromium and Firefox manifests. `manifest.chromium-dev.json` adds the public key that fixes the dev build's ID. |
| `build.ts` | Builds every target and zips the store packages. |
| `store/` | Listing, permission justifications, data-use answers and reviewer notes for each store. |
| `tools/register.ts` | Writes the dev host manifest into a test profile. |
| `tools/live.ts` | Live canary and soak runs in real browsers with test profiles. |
| `tools/activate.swift` | Brings one process to the front by pid, for a second instance of an app that is also in use. |

The capture service's side lives in `capture/`: `browserSocket.ts` (native messaging hosts), `browserLocal.ts`,
`pairing.ts` and `websocket.ts` (the local connection), `browser.ts` (the page gate), and `address.ts` (the address
rule, shared with the extension). The native messaging host is a mode of each capture helper (`BrowserHost.swift`,
`BrowserHost.cs`), and so is `--tcp-peer`, which names the app behind a local connection.

## Building

`node browser/build.ts` compiles the TypeScript with `tsc` (unminified, comments kept) and writes `browser/dist/`:

| Output | Use |
|---|---|
| `chromium/`, `daylens-chromium-<version>.zip` | Chrome Web Store and Edge Add-ons |
| `firefox/`, `daylens-firefox-<version>.zip` | Firefox Add-ons |
| `daylens-firefox-source-<version>.zip` | The source package Firefox reviewers rebuild from |
| `chromium-dev/`, `firefox-dev/` | Unpacked dev builds: fixed Chromium ID `dgidcofcmgnlicmmepgomalcdcbgjjjg`, and the local connection allowed on every platform |

Store builds use the local connection only on Windows, where the Microsoft Store package cannot register a native
messaging host.

## Tests

- `npm test` runs the extension logic, the page gate, pause, the address rule, the socket, and the local connection
  (a server without the secret, a squatter on the first port, a web page origin, another user's peer, a pairing link
  opened by a page).
- `swift test` in `native/macos` and `dotnet test` in `native/windows` cover framing, launch detection, the allowlist,
  the `tab` encoding and `--tcp-peer`.

## Live runs

`tools/live.ts` drives a real browser on a separate test profile and never touches a real profile. Chromium browsers
read the host manifest from the test profile's own folder; Firefox reads only
`~/Library/Application Support/Mozilla/NativeMessagingHosts`, so the run writes it there and removes it afterwards. A run
waits until the Mac has had no keyboard or mouse input for two minutes, shows a notification, counts down 30 seconds,
and redoes any step that something else interrupted. For Dia, it first proves that the launch is a separate instance
on the test profile before the extension is loaded.

```bash
node browser/tools/live.ts canary --browser cft --app "<Chrome for Testing.app>" --helper native/macos/.build/release/daylens-capture-macos --out <dir> --activate <activate binary> --procstat <procstat binary>
```

`--browser` takes `cft`, `dia` or `firefox`. `--local` forces the local connection (no host manifest, the listener
on, pairing through the popup). `soak --minutes 60` runs an hour of scripted browsing while `procstat` samples the host,
the extension's process and the service.
`storeshots --browser cft` captures the popup connected, paused and with Daylens not running, over a neutral page,
as 1280×800 store screenshots.

The canary opens unique canary pages in a private window next to a normal window showing the same page. It then
checks the database, the WAL, the service log and the browser's log for the canary strings, while the window is open,
after it closes and after a restart, and checks that private time is stored as browser time with no page.
