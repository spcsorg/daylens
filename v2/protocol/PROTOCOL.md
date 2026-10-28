# Capture helper protocol, version 1

Every native helper (macOS, Windows, later Linux) speaks this protocol to the capture service. Helpers report facts only. Every decision (cleaning, merging, privacy, exclusions, health) is made in shared code in `v2/capture/`.

## Transport

- The capture service starts the helper with stdin and stdout as pipes.
- The helper writes one JSON object per line to stdout, UTF-8, `\n` terminated, at most 16 KiB per line.
- `seq` is assigned when a line is created, before it is queued. stdout is written from a dedicated writer thread through a bounded queue (1024 lines). When the queue is full, `focus` and `input` lines are dropped first; `heartbeat`, `session`, `power`, `clock`, `hello` and `bye` use a small reserve. Drops are counted in the next `heartbeat` and show as a jump in `seq`. A stalled reader never blocks capture.
- stderr carries only fixed diagnostic codes (`code=value` tokens). It never contains titles, paths, app names or exception messages. The service drops any stderr line that is not in that form.
- stdin carries control lines:
  - `{"op":"shutdown"}`: exit cleanly, ending with `bye`.
  - `{"op":"snapshot"}`: re-emit the display's current state as `power` with `snapshot: true` (when the helper knows it), then `session`, `focus` and `input`, with `trigger: "snapshot"` / `snapshot: true`. The display and the lock come first because the service records nothing while it cannot tell whether the display is on or the screen unlocked. The service asks for one after lost lines and after resume.
  - End of file: the capture service is gone. Exit at once.

## Envelope

```json
{"v":1,"run":"6f1c2b0e-…","seq":118,"boot":"6C1E…",
 "t":{"wall_ms":1792130412345,"mono_us":881234567890,"tz":"Example/Town","tz_offset_min":-300},
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
| `hello` | `awake_us` (as in `heartbeat`, so the first heartbeat can show the machine did not sleep in between), `helper`, `boot_identity` (`kernel`: the OS names the boot, so it survives clock changes; `clock`: the Windows fallback of wall time minus uptime, which a clock change can rename, reported as degraded capture health), `version`, `pid`, `os`, `permissions`, `config: {heartbeat_s, idle_threshold_s, reconcile_s}`. First line of every run, followed by a snapshot. Until the helper reports the display's state, the service records nothing: a helper can start during a dark wake. |
| `heartbeat` | `awake_us` (monotonic microseconds since boot **excluding** time asleep: macOS `CLOCK_UPTIME_RAW`, Windows `QueryUnbiasedInterruptTime`; the service compares it between heartbeats to tell a stalled helper from a sleeping machine, including dark wakes and missed sleep notices), `permissions`, `registrations` (`{focus, session, power}`: whether the helper's subscription to that event source is in place; a failed one is retried and the service records the time it was missing; while `session` is false the service records nothing, since it cannot see a lock), `titles` (title channel: `ok`, `degraded`, `stalled`, `no_permission`), `stall_ms` (how long a worker has been stuck in one call, 0 if none), `dropped` (lines dropped at the queue since start). Sent every `heartbeat_s` from the helper's main event thread, so a stuck event loop stops heartbeats even if other threads still emit. |
| `focus` | `trigger`, `app`, `window`. The front app, the focused window or its title changed; or reconciliation found a difference; or a snapshot was requested. Every `focus` line carries the identity of the app that owns the window, so privacy rules are decided per line and never depend on line order. |
| `input` | `state` (`idle` or `active`), `last_input_wall_ms`, `threshold_s`, `snapshot`. Input crossed the idle threshold, or a snapshot. |
| `session` | `state`: `locked`, `unlocked`, `console_disconnect`, `console_connect`, `remote_connect`, `remote_disconnect`, `logoff`, `logon`, `unknown`; `snapshot`. After a snapshot of `unknown`, the service records nothing until a known state arrives. |
| `power` | `state`: `sleep`, `resume`, `resume_user`, `display_off`, `display_on`, `display_dim`, `display_unknown` (the helper could not read the display's state; only with `snapshot: true`); `snapshot` (optional, default false): true when the line reports the display's current state rather than a change (macOS: off when every online display is asleep, from `CGDisplayIsAsleep`; Windows: the value `GUID_SESSION_DISPLAY_STATUS` delivers on registration, then the last one it reported). `resume` means the system is running again, cause unknown. `resume_user` is evidence that a person caused or followed the resume (Windows `PBT_APMRESUMESUSPEND`). Waking alone is never the user returning: after a `resume`, the service records nothing until the first input after it (an `input` line whose `last_input_wall_ms` is after the resume), an unlock, console or remote connection or logon, or an unlock a snapshot finds after the screen was locked. |
| `clock` | `change`: `time_changed` or `timezone_changed`. |
| `loss` | `channel` (`focus`), `count`, `from_wall_ms`, `to_wall_ms`. Focus work was dropped inside the helper before it became a line (an internal queue was full), so no `seq` shows it. Sent once the queue drains. |
| `bye` | `reason`. Last line of a clean exit. |
| `tab` | Browser host only, never a capture helper. `trigger` (`activated`, `focus`, `updated`, `removed`, `snapshot`, `startup`, `paused`), `state` (`page` or `unknown`), `reason`, `browser`, `extension`, `window`, `tab`, `url`, `title`. See [Browser host](#browser-host). |

`trigger`: `app_changed`, `window_changed`, `title_changed`, `reconcile`, `snapshot`.

Every `reconcile_s` the helper also reads the display and lock state again, since a notice can be missed while the machine stays awake, and reports what changed since it last reported as `power` or `session` with `snapshot: true`: the display going dark or coming on, the screen locking or unlocking, or a display or lock state it can no longer read (`display_unknown`, `unknown`). It reads them before the window in front, so a window it finds locked or dark is not recorded; on Windows, whose display value arrives as a message, the window is read from a message posted after the re-registration. A snapshot reports `display_unknown` too when the display cannot be read. A state it could not read (the display on macOS, the lock on Windows) is read again on each of these ticks until it can be. Windows reads the display by registering for `GUID_SESSION_DISPLAY_STATUS` again, which delivers its current value. The service records nothing while either state is unknown; once one has been unknown for longer than `reconcile_s`, it records an `events_unavailable` gap (scope `power` for the display, `session` for the lock, detail `{"state":"unknown"}`) from when it became unknown until it is known.

`app`: `app_id` (bundle ID on macOS; the AUMID for packaged Windows apps, else the executable path), `name`, `path`, `pid`, `registered_browser`, `identity_state`, `store`.

`window`: `window` (an opaque window ID), `title`, `title_state`, and optionally `mode` (`normal`, `private`, `unknown`) when the platform can tell a private window from a normal one. No helper sets `mode` yet. A `private` window never has its title stored. A browser window's title stays withheld even while the extension reports pages, because the window in front may be one the extension cannot see.

`permissions` is `{accessibility}`, each `granted`, `denied` or `not_applicable`.

`identity_state`: `ok`; `access_denied` (the process could not be queried, identity fields are null); `timeout` (the query hung and was abandoned); `gone` (the process exited first); `none` (nothing is in front); `unresolved` (a host window, such as a Windows ApplicationFrameHost frame, whose real app could not be found). Shared code treats any state other than `ok` as unknown and withholds the title.

`engine` is what the app's own files say about its web engine: `browser` (a browser's engine and browser resources: a Chromium framework with its own renderer helper, or Gecko's `browser/omni.ja`; on Windows `chrome.dll`, `msedge.dll`, or Chromium without `resources/app.asar`, or Gecko's `browser/omni.ja`; for packaged apps, a manifest declaring either `http` or `https`), `app_runtime` (an app built on a web runtime: Electron's `app.asar` or Electron Framework, or CEF), `none` (no web engine found), `unknown` (the helper could not inspect the app). Proving from files that an app is not a browser is impossible (an Electron app can be a browser with private tabs), so shared code withholds titles for `browser` engines. An `app_runtime` needs a matching signed identity on the built-in list or the user’s kept-title list. User-kept titles require event ordering after activation: the same kernel boot with `mono_us` at or after activation, or a later kernel boot proven by a current native clock reading. Unproven ordering and `unknown` engines withhold titles.

`signer` is who signed the app, as verified by the operating system: the Team ID from the running process's code signature on macOS, the Authenticode publisher (after `WinVerifyTrust`) on Windows; `null` when unsigned or not verifiable.

`version_info` (Windows; `null` on macOS) is the executable's version resource: `original_filename` and `product_name`. A trusted Windows executable must match its file name, its publisher and one of these.

`registered_browser` reports whether the app handles either `http` or `https`. Windows checks registered capabilities, StartMenuInternet, UserChoice ProgIDs, effective protocol commands from `AssocQueryString`, and the schemes’ `OpenWithProgids`; commands through Squirrel’s `Update.exe --processStart` also identify their target executable. Package manifests declaring either scheme count too. Windows registration verdicts are cached, warmed outside resolver stall accounting, and invalidated by `RegNotifyChangeKeyValue` on registration, association and capability keys in both hives. macOS reads the current Info.plist and all LaunchServices handlers for either scheme on every resolution, without caching the verdict. An incomplete lookup reports `true` and emits a content-free diagnostic, so a failed read cannot permit user-kept titles. Shared code applies privacy rules; the user list cannot override link handling.

`store` is set for packaged Windows apps: `aumid` (the application user model ID) and `package` (the package full name).

`title_state`: `ok` (`title` is present); `empty` (the window has no title); `no_window` (the app has no window to report: closed, hidden, or a desktop such as Finder's); `no_permission` (Accessibility is not granted); `timeout` (the read hung); `unavailable` (no focused window or the read failed). `title` is present exactly when `title_state` is `ok`, truncated to 1024 UTF-16 code units. Helpers send titles unmodified; cleaning happens in shared code.

## Contract tests

`fixtures/valid.json` holds one golden line per kind and platform; `fixtures/invalid.json` holds lines the service must reject, with the reason. The TypeScript validator, the Swift encoder and the C# encoder are all tested against these files.

## One-shot commands

The service also runs the macOS capture helper for single answers. Each prints its answer on stdout and exits; none of them captures anything.

- `<helper> --host-of <pid>...` names the app each process runs in, for agent sessions. One JSON line per pid: `{"pid":<n>,"basis":"responsible"|"parent"|"none","app":{"app_id","name","path","pid"}|null}`. `responsible`: the process macOS holds responsible for it is a running app with a bundle (not the process itself). `parent`: the nearest app among its parent processes, the process itself excluded. `none`: neither; `app` is `null`. `--no-responsibility` skips the responsible-process call. The service waits at most 5 s; a pid with no valid line gets no answer, and its session's app stays unknown. macOS only; on other platforms every session's app is unknown.
- `<helper> --responsible-pid <pid>...` prints, per pid, the pid macOS holds responsible for that process and the pid asked about, tab-separated (`-` when unknown). The capture helper re-executes itself at start with that responsibility disclaimed, so it is responsible for itself and holds its own window-title permission; this command checks that.
- `<helper> --ordering-point` prints `{"boot","mono_us","boot_identity"}` for the moment it runs.
- `--tcp-peer` and `--secret` are described under [Local connection](#local-connection).

## Browser host

The Daylens browser extension talks to a native messaging host: the capture helper started by the browser, which then forwards to the capture service. The helper runs as the host only when the browser starts it with an extension origin (Chromium: `chrome-extension://<id>/`, plus `--parent-window=` on Windows; Firefox: the host manifest path and the add-on ID) and the ID is on the helper's allowlist. In this mode it captures nothing.

### Transport

- The capture service listens on a local endpoint. macOS and Linux: a Unix socket, `<per-user temp folder>/daylens-v2/browser.sock` (macOS: `confstr(_CS_DARWIN_USER_TEMP_DIR)`; Linux: `$XDG_RUNTIME_DIR`), in a folder only the user can open, socket mode 0600. Windows: the named pipe `\\.\pipe\daylens-v2-browser-<user name>`. `DAYLENS_V2_BROWSER_SOCKET` overrides the path for both sides.
- The host checks that the listener runs as the same user (`getpeereid` on macOS, the pipe server's process token on Windows) before sending anything.
- Host to service: one JSON line per message, UTF-8, at most 16 KiB. A line is either a protocol line of kind `tab` with the host's own `run` and `seq`, or a control op: `{"op":"browser_pause","until_wall_ms":<ms>|null,"browser":<app identity>,"profile":<id>|null,"req":<id>}`, `{"op":"browser_resume","browser":<app identity>,"profile":<id>|null,"req":<id>}`, `{"op":"status"}`. A pause or resume always names the browser that started the host, with the identity the host stamps on its `tab` lines; it pauses that browser only (its pages and its windows), never the rest of Daylens. `until_wall_ms` `null` means until resumed. `profile` is the id the extension made up for its browser profile (at most 64 characters): each profile's pause is held apart, a resume ends only that profile's, and the browser stays paused while any is in force. The service refuses a browser it cannot name. `req` (optional; 1–32 letters, digits, `_` or `-`) is the id the extension gave this pause or resume; the service echoes it on the `status` or `error` that answers it, and the extension takes only that reply as the answer, since a `status` from another browser's change can arrive first.
- Service to host: `{"op":"status","capture":"running"|"paused","until_wall_ms":<ms>|null}` on connect, on every pause change, in answer to `status` and after a pause or resume it carried out (then with that op's `req`), where `capture` says whether all of Daylens is paused; `{"op":"error","for":<op>,"req":<id>}` when a pause or resume failed; `{"op":"snapshot","epoch":<n>|null}` when the service needs the present state (a new app or window came to the front, or lines were lost). The host passes `epoch` to the extension, and the extension's answer carries it back.
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
| `url` | The page address after the [address rule](#address-rule), at most 2048 characters. Present exactly when `state` is `page`. |
| `title` | The tab title, at most 1024 UTF-16 code units, or `null`. Only with `page`. |
| `epoch` | Optional. Present only on an answer to a snapshot request: the focus epoch that request named. |

`t` is when the host received the message. Every helper focus line that changes the app or the window starts a new focus epoch, ends the current page, and sends a snapshot request naming the epoch. The service stores a page only while the helper's latest focus line shows that same browser in front (same `pid`, same `app_id`) and the evidence belongs to the current epoch: an answer naming it, or a line whose `t.mono_us` on the same `boot` is not before the epoch began. Arrival order never decides. Everything else is stored as browser time with no page.


### Address rule

`capture/address.ts`, shared by the extension and the history readers. It keeps the page address and a short list of
search and page-identity parameters; everything else is removed.

- Only `http`, `https` and `file` addresses are kept. The user name, password and fragment are removed. The path is
  kept as written, so a secret in the path is not detected.
- A query parameter is kept only by its name, compared lowercased with separators removed:
  - searches, any text that is not a JSON object or array: `q`, `query`, `search`, `search_query`, `term`, `_nkw`;
  - the short search aliases `s` and `k`, the same, and not key-shaped (below);
  - identities, any value: `id`, `ids`, `v`, `list`, `resid`, `cid`, `eid`, `file`, `doc`, `item`, `video`, `post`,
    `node`, `node-id`, `sha`, `commit`, `rev`, `sourcedoc`, `th`;
  - `p` and `page`, digits only; `t`, a time only (digits, or `1h2m30s` and its parts);
  - display settings: `hl`, `lang`, `m`, `tab`, `view`, `usp`, `dl`, `sort`, `filter`, `category`, `cat`, unless the
    value is a UUID, 32 or more hex digits, or key-shaped.
- Key-shaped means 20 or more characters that are either hex mixing digits and letters, or base64 or base64url with
  at most 10% separators, two of lower case, upper case and digits, at least 3.5 bits of entropy per character, and a
  digit or at least four capitals after the first character.
- A name that contains a secret word (token, key, session, sid, password, signature, auth and the like) or is a click
  or campaign tracking ID (`utm_*`, `mc_*`, `hs*`, names ending in `clid` or `clkid`, `igshid`, `srsltid`, `gbraid`,
  `wbraid` and the like) is never kept.
- A kept parameter is also removed when its value, with C0 controls stripped and percent-decoded up to three times,
  is at any step a `Bearer` token, a `Basic` token whose base64 contains a colon byte, a JWT (three parts) or JWE
  (five parts) whose first part decodes to a JSON object with `alg`, a `javascript:`, `data:`, `vbscript:` or `blob:`
  address, or an address from which this rule would remove anything; or when the decoding is ambiguous. In a search
  or alias, only a form that starts with a scheme and `//`, with `//` or `\`, or is an absolute URL with a host counts
  as an address; anything else is text, so `F# tutorial` and `site:example.com` stay. A kept value is never rewritten.
- Over 2048 characters, the query is removed, then the path.

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
  checkpoint reports it complete, no `browser_pairings` entry still has a `key` field, and no database file still
  holds one of the migrated keys. Those keys are held in memory only while the scrub runs; a scrub resumed after a
  restart relies on the checkpoint and vacuum alone. The rewritten row and the marker are never the writes dropped when the write queue
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
