# Capture helper protocol, version 1

Every native helper (macOS, Windows, later Linux) speaks this protocol to the capture service. Helpers report facts only. Every decision (cleaning, merging, privacy, exclusions, health) is made in shared code in `v2/capture/`.

## Transport

- The capture service starts the helper with stdin and stdout as pipes.
- The helper writes one JSON object per line to stdout, UTF-8, `\n` terminated, at most 16 KiB per line.
- `seq` is assigned when a line is created, before it is queued. stdout is written from a dedicated writer thread through a bounded queue (1024 lines). When the queue is full, `focus` and `input` lines are dropped first; `heartbeat`, `session`, `power`, `clock`, `hello` and `bye` use a small reserve. Drops are counted in the next `heartbeat` and show as a jump in `seq`. A stalled reader never blocks capture.
- stderr carries only fixed diagnostic codes (`code=value` tokens). It never contains titles, paths, app names or exception messages. The service drops any stderr line that is not in that form.
- stdin carries control lines:
  - `{"op":"shutdown"}`: exit cleanly, ending with `bye`.
  - `{"op":"snapshot"}`: re-emit current `focus`, `input` and `session` with `trigger: "snapshot"` / `snapshot: true`. The service asks for one after lost lines and after resume.
  - End of file: the capture service is gone. Exit at once.

## Envelope

```json
{"v":1,"run":"6f1c2b0e-…","seq":118,"boot":"6C1E…",
 "t":{"wall_ms":1792130412345,"mono_us":881234567890,"tz":"Africa/Kigali","tz_offset_min":120},
 "platform":"macos","source":"ax_observer","kind":"window","obs":{…}}
```

| Field | Meaning |
|---|---|
| `v` | Protocol version. The service rejects any other value. |
| `run` | Random ID for this helper process. |
| `seq` | 0 for the first line of a run, then +1 for every line created, including lines later dropped. A jump means lines were lost. |
| `boot` | ID of the current boot. `mono_us` values compare only within one boot. macOS: `kern.bootsessionuuid`. Windows: `boot-` and the boot time in minutes since the epoch, computed as wall clock minus interrupt time. A clock change can alter it within one boot; the service then only skips mono comparisons across that change. |
| `t.wall_ms` | When the event happened. Unix epoch milliseconds, UTC. |
| `t.mono_us` | When the event happened, monotonic microseconds since boot, **including time asleep**. macOS: `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1000`. Windows: `QueryInterruptTimePrecise() / 10` (100 ns units). Microseconds keep the value exact in a JSON number for centuries of uptime. |
| `t.tz` | IANA time zone at the event. Windows falls back to the Windows zone ID when it cannot be mapped. |
| `t.tz_offset_min` | UTC offset at the event, minutes, east positive. |
| `platform` | `macos`, `windows` or `linux`. |
| `source` | The OS mechanism that produced the line (`nsworkspace`, `ax_observer`, `win_event`, `wts`, `power`, `idle_timer`, `reconcile`, `helper`, …). Lowercase, at most 32 characters. |
| `kind` | One of the kinds below. Unknown kinds are rejected. |
| `obs` | The observation. Unknown fields are dropped. |

The capture service adds the **recorded time** (`recorded_wall_ms`) when it stores the observation.

## Kinds

| Kind | `obs` |
|---|---|
| `hello` | `helper`, `version`, `pid`, `os`, `permissions`, `config: {heartbeat_s, idle_threshold_s, reconcile_s}`. First line of every run, followed by a snapshot. |
| `heartbeat` | `awake_us` (monotonic microseconds since boot **excluding** time asleep: macOS `CLOCK_UPTIME_RAW`, Windows `QueryUnbiasedInterruptTime`; the service compares it between heartbeats to tell a stalled helper from a sleeping machine, including dark wakes and missed sleep notices), `permissions`, `registrations` (`{focus, session, power}`: whether the helper's subscription to that event source is in place; a failed one is retried and the service records the time it was missing), `titles` (title channel: `ok`, `degraded`, `stalled`, `no_permission`), `stall_ms` (how long a worker has been stuck in one call, 0 if none), `dropped` (lines dropped at the queue since start). Sent every `heartbeat_s` from the helper's main event thread, so a stuck event loop stops heartbeats even if other threads still emit. |
| `focus` | `trigger`, `app`, `window`. The front app, the focused window or its title changed; or reconciliation found a difference; or a snapshot was requested. Every `focus` line carries the identity of the app that owns the window, so privacy rules are decided per line and never depend on line order. |
| `input` | `state` (`idle` or `active`), `last_input_wall_ms`, `threshold_s`, `snapshot`. Input crossed the idle threshold, or a snapshot. |
| `session` | `state`: `locked`, `unlocked`, `console_disconnect`, `console_connect`, `remote_connect`, `remote_disconnect`, `logoff`, `logon`, `unknown`; `snapshot`. |
| `power` | `state`: `sleep`, `resume`, `resume_user`, `display_off`, `display_on`, `display_dim`. `resume` means the system is running again, cause unknown. `resume_user` is evidence that a person caused or followed the resume (Windows `PBT_APMRESUMESUSPEND`). Waking alone is never the user returning. |
| `clock` | `change`: `time_changed` or `timezone_changed`. |
| `loss` | `channel` (`focus`), `count`, `from_wall_ms`, `to_wall_ms`. Focus work was dropped inside the helper before it became a line (an internal queue was full), so no `seq` shows it. Sent once the queue drains. |
| `bye` | `reason`. Last line of a clean exit. |
| `tab` | Browser host only, never a capture helper. `trigger` (`activated`, `focus`, `updated`, `removed`, `snapshot`, `startup`, `paused`), `state` (`page` or `unknown`), `reason`, `browser`, `extension`, `window`, `tab`, `url`, `title`. See [Browser host](#browser-host). |

`trigger`: `app_changed`, `window_changed`, `title_changed`, `reconcile`, `snapshot`.

`app`: `app_id` (bundle ID on macOS; the AUMID for packaged Windows apps, else the executable path), `name`, `path`, `pid`, `registered_browser`, `identity_state`, `store`.

`window`: `window` (an opaque window ID), `title`, `title_state`, and optionally `mode` (`normal`, `private`, `unknown`) when the platform can tell a private window from a normal one. No helper sets `mode` yet. A `private` window never has its title stored. A browser window's title stays withheld even while the extension reports pages, because the window in front may be one the extension cannot see.

`permissions` is `{accessibility}`, each `granted`, `denied` or `not_applicable`.

`identity_state`: `ok`; `access_denied` (the process could not be queried, identity fields are null); `timeout` (the query hung and was abandoned); `gone` (the process exited first); `none` (nothing is in front); `unresolved` (a host window, such as a Windows ApplicationFrameHost frame, whose real app could not be found). Shared code treats any state other than `ok` as unknown and withholds the title.

`registered_browser` is a platform fact, not a decision: the app is registered to open `http` and `https` links. Shared code decides what that means for privacy.

`store` is set for packaged Windows apps: `aumid` (the application user model ID) and `package` (the package full name).

`title_state`: `ok` (`title` is present); `empty` (the window has no title); `no_window` (the app has no window to report: closed, hidden, or a desktop such as Finder's); `no_permission` (Accessibility is not granted); `timeout` (the read hung); `unavailable` (no focused window or the read failed). `title` is present exactly when `title_state` is `ok`, truncated to 1024 UTF-16 code units. Helpers send titles unmodified; cleaning happens in shared code.

## Contract tests

`fixtures/valid.json` holds one golden line per kind and platform; `fixtures/invalid.json` holds lines the service must reject, with the reason. The TypeScript validator, the Swift encoder and the C# encoder are all tested against these files.

## Browser host

The Daylens browser extension talks to a native messaging host: the capture helper started by the browser, which then forwards to the capture service. The helper runs as the host only when the browser starts it with an extension origin (Chromium: `chrome-extension://<id>/`, plus `--parent-window=` on Windows; Firefox: the host manifest path and the add-on ID) and the ID is on the helper's allowlist. In this mode it captures nothing.

### Transport

- The capture service listens on a local endpoint. macOS and Linux: a Unix socket, `<per-user temp folder>/daylens-v2/browser.sock` (macOS: `confstr(_CS_DARWIN_USER_TEMP_DIR)`; Linux: `$XDG_RUNTIME_DIR`), in a folder only the user can open, socket mode 0600. Windows: the named pipe `\\.\pipe\daylens-v2-browser-<user name>`. `DAYLENS_V2_BROWSER_SOCKET` overrides the path for both sides.
- The host checks that the listener runs as the same user (`getpeereid` on macOS, the pipe server's process token on Windows) before sending anything.
- Host to service: one JSON line per message, UTF-8, at most 16 KiB. A line is either a protocol line of kind `tab` with the host's own `run` and `seq`, or a control op: `{"op":"pause","for":"hour"|"tomorrow"|"until_resumed"}`, `{"op":"resume"}`, `{"op":"status"}`.
- Service to host: `{"op":"status","capture":"running"|"paused","until_wall_ms":<ms>|null}` on connect, on every pause change and in answer to `status`; `{"op":"snapshot","epoch":<n>|null}` when the service needs the present state (a new app or window came to the front, or lines were lost). The host passes `epoch` to the extension, and the extension's answer carries it back.
- A host that cannot reach the service retries on every extension message, and on macOS when the socket folder changes; on Windows every 30 s.

### `tab`

| Field | Meaning |
|---|---|
| `trigger` | The browser event behind the line. |
| `state` | `page`: the focused tab of a focused normal window. `unknown`: anything the extension cannot see or does not count: another app, a private window, devtools, a popup, no window. |
| `reason` | `null` for a page; for unknown one of `no_focused_window`, `not_normal`, `no_tab`, `no_address`, `paused`. |
| `browser` | The process that started the host, found by the host from its own parent (on Windows, the parent of `cmd.exe` when Chromium puts it in between), in the same shape as `app`. Never reported by the extension. `registered_browser` is not read for tab lines. |
| `extension` | The extension ID: 32 letters `a`–`p` for Chromium, the add-on ID for Firefox. |
| `window`, `tab` | The browser's own IDs, as strings; only meaningful within one browser run. |
| `url` | The page address after the shared address rule (`capture/address.ts`): no user name or password, no fragment, no query parameters that carry secrets, at most 2048 characters. Present exactly when `state` is `page`. |
| `title` | The tab title, at most 1024 UTF-16 code units, or `null`. Only with `page`. |
| `epoch` | Optional. Present only on an answer to a snapshot request: the focus epoch that request named. |

`t` is when the host received the message. Every helper focus line that changes the app or the window starts a new focus epoch, ends the current page, and sends a snapshot request naming the epoch. The service stores a page only while the helper's latest focus line shows that same browser in front (same `pid`, same `app_id`) and the evidence belongs to the current epoch: an answer naming it, or a line whose `t.mono_us` on the same `boot` is not before the epoch began. Arrival order never decides. Everything else is stored as browser time with no page.


## Local connection

Where the browser cannot find a native messaging host (the Microsoft Store package on Windows), the extension talks to
the capture service directly over a WebSocket on `127.0.0.1`. Store builds use it only on Windows and only after native
messaging reports that the host is not installed; the dev builds allow it everywhere. The service listens only on
Windows, or anywhere with `DAYLENS_V2_BROWSER_LOCAL=1`.

### Listener

- The first free port of 27481, 37471, 46417, on `127.0.0.1` only, path `/daylens/browser`. Every other request gets
  404. At most 32 connections.
- An upgrade is refused unless the peer address is `127.0.0.1`, `Host` is exactly `127.0.0.1:<port>` (no DNS
  rebinding), and `Origin` is an allowed extension: `chrome-extension://<id>` with an ID on the list in
  `capture/pairing.ts`, or any `moz-extension://<uuid>` (Firefox gives each install its own UUID).
- The service then asks the capture helper which process owns the other end: `<helper> --tcp-peer <service port>
  <peer port>` prints `{"ok":true,"browser":<app identity>}` or `{"ok":false,"reason":"no_socket"|"other_user"|"no_app"}`.
  macOS finds the socket with libproc and climbs to the nearest regular app; Windows reads the TCP table and climbs
  through parents running the same executable. Every process on the way must belong to this user. That identity is
  the `browser` of every tab line on the connection, exactly as a native host would stamp it.

### Pairing

- The extension makes a pairing (`id`: 16 random bytes, `key`: 32 random bytes, both base64url, and its own origin)
  and opens `daylens://pair?v=1&id=<id>&key=<key>&origin=<origin>`. The operating system hands the link to the Daylens
  app, which writes `{"op":"pair","link":"<link>"}` to the service's stdin. The key never crosses the socket.
- A link only makes a pending pairing (at most 8, oldest dropped), kept in memory. It becomes stored only when a
  connection from that same origin proves it, and then replaces earlier pairings for that origin. The app can remove
  one with `{"op":"unpair","id":"<id>"}`.
- A stored pairing's key is kept in the platform's secure storage through the capture helper:
  `<helper> --secret set|get|delete <id>`, with the key on stdin (`set`) or stdout (`get`), never on the command line;
  exit 2 means no such item. macOS: a generic password in the login Keychain, service `app.daylens.browser.pairing`,
  account `<id>`. Windows: a generic credential in Credential Manager, target `Daylens/browser-pairing/<id>`. The
  database (meta key `browser_pairings`) keeps only `id`, `origin` and `paired_wall_ms`. A key found in the database by
  an earlier version moves to secure storage at start, and the database is then checkpointed and vacuumed so no older
  copy of the row is left in the files. Another open reader can hold that up: the database keeps a `scrub_pending`
  marker, store health reports `scrubPending`, and the scrub is retried at every start and every minute until a
  checkpoint reports it complete and neither the `browser_pairings` row nor any database file still holds a
  `"key":"<43 characters>"` value. The rewritten row and the marker are never the writes dropped when the write queue
  is full. A pairing whose key is missing from secure storage is removed
  and the browser shows Connect again; unpairing or replacing a pairing deletes its key.
- A Firefox origin (`moz-extension://`) cannot be pinned, so any Firefox extension could make and prove its own
  pairing. A new Firefox pairing therefore waits for the person: once proven, the service holds the connection in a
  confirm phase, sends the extension `{"t":"awaiting"}`, and writes `{"op":"confirm_pairing","id":"<id>","browser":"<app
  name>"}` to its stdout. The app shows one line with Allow and Don't allow and answers on stdin with
  `{"op":"pair_decision","id":"<id>","allow":true|false}`. Allow completes the held connection (and any later one for
  that pairing, without asking again). Don't allow drops the pairing and sends `{"t":"denied"}`; the extension forgets
  it and shows Connect again. Nothing about pages is accepted before Allow. Chromium origins, pinned to known IDs, are
  never asked about.

### Handshake

All messages are JSON text frames, at most 16 KiB. No page is sent before step 4.

1. Extension: `{"t":"hello","v":1,"pair":"<id>","nonce":"<32 random bytes>"}`.
2. Service: `{"t":"unpaired"}` and close, or `{"t":"challenge","v":1,"nonce":"<32 random bytes>","proof":<P_service>}`.
3. The extension checks `P_service` and only then sends `{"t":"proof","proof":<P_extension>}`. A server without the
   key never sees a proof it could replay.
4. Service checks `P_extension`. A new Firefox pairing first waits for Allow (above). Then the service sends `status`
   and `snapshot`; from here the connection is a browser host.

`P_role = HMAC-SHA256(key, "daylens-browser-pair-v1\n<role>\n<origin>\n127.0.0.1:<port>\n<id>\n<extension nonce>\n<service nonce>")`,
base64url, compared in constant time. Binding the port means a squatter on one port cannot relay a proof made by the
real service on another.

### Messages after the handshake

Extension to service: the same `tab` messages the extension sends a native host, plus `{"t":"status"}` and
`{"t":"ping"}` every 20 s (Chrome stops an idle service worker after 30 s). The service builds the protocol line
itself: its own `run` and `seq`, `t` from the helper's clock, `browser` from `--tcp-peer`, `extension` from `Origin`.
Service to extension: `{"t":"status",...}` and `{"t":"snapshot"}`, as from a native host.
