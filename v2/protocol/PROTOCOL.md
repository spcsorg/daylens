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
| `heartbeat` | `permissions`, `titles` (title channel: `ok`, `degraded`, `stalled`, `no_permission`), `stall_ms` (how long a worker has been stuck in one call, 0 if none), `dropped` (lines dropped at the queue since start). Sent every `heartbeat_s` from the helper's main event thread, so a stuck event loop stops heartbeats even if other threads still emit. |
| `focus` | `trigger`, `app`, `window`. The front app, the focused window or its title changed; or reconciliation found a difference; or a snapshot was requested. Every `focus` line carries the identity of the app that owns the window, so privacy rules are decided per line and never depend on line order. |
| `input` | `state` (`idle` or `active`), `last_input_wall_ms`, `threshold_s`, `snapshot`. Input crossed the idle threshold, or a snapshot. |
| `session` | `state`: `locked`, `unlocked`, `console_disconnect`, `console_connect`, `remote_connect`, `remote_disconnect`, `logoff`, `logon`, `unknown`; `snapshot`. |
| `power` | `state`: `sleep`, `resume`, `resume_user`, `display_off`, `display_on`, `display_dim`. `resume` means the system is running again, cause unknown. `resume_user` is evidence that a person caused or followed the resume (Windows `PBT_APMRESUMESUSPEND`). Waking alone is never the user returning. |
| `clock` | `change`: `time_changed` or `timezone_changed`. |
| `bye` | `reason`. Last line of a clean exit. |

`trigger`: `app_changed`, `window_changed`, `title_changed`, `reconcile`, `snapshot`.

`app`: `app_id` (bundle ID on macOS; the AUMID for packaged Windows apps, else the executable path), `name`, `path`, `pid`, `registered_browser`, `identity_state`, `store`.

`window`: `window` (an opaque window ID), `title`, `title_state`.

`permissions` is `{accessibility}`, each `granted`, `denied` or `not_applicable`.

`identity_state`: `ok`; `access_denied` (the process could not be queried, identity fields are null); `timeout` (the query hung and was abandoned); `gone` (the process exited first); `none` (nothing is in front). Shared code treats any state other than `ok` as unknown and withholds the title.

`registered_browser` is a platform fact, not a decision: the app is registered to open `http` and `https` links. Shared code decides what that means for privacy.

`store` is set for packaged Windows apps: `aumid` (the application user model ID) and `package` (the package full name).

`title_state`: `ok` (`title` is present); `empty` (the window has no title); `no_permission` (Accessibility is not granted); `timeout` (the read hung); `unavailable` (no focused window or the read failed). `title` is present exactly when `title_state` is `ok`, truncated to 1024 UTF-16 code units. Helpers send titles unmodified; cleaning happens in shared code.

## Contract tests

`fixtures/valid.json` holds one golden line per kind and platform; `fixtures/invalid.json` holds lines the service must reject, with the reason. The TypeScript validator, the Swift encoder and the C# encoder are all tested against these files.
