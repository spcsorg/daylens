# Capture helper protocol, version 1

Every native helper (macOS, Windows, later Linux) speaks this protocol to the capture service. Helpers report facts only. Every decision (cleaning, merging, privacy, exclusions, health) is made in shared code in `v2/capture/`.

## Transport

- The capture service starts the helper with stdin and stdout as pipes.
- The helper writes one JSON object per line to stdout, UTF-8, `\n` terminated, at most 16 KiB per line.
- stdout is written from a dedicated writer thread through a bounded queue. If the queue is full the line is dropped, the drop is counted in the next `heartbeat`, and the gap shows as a jump in `seq`. A stalled reader never blocks capture.
- stderr is for diagnostics only. It never contains titles, paths or app names.
- stdin carries control lines. `{"op":"shutdown"}` asks for a clean exit. End of file on stdin means the capture service is gone, and the helper exits at once.

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
| `boot` | ID of the current boot. `mono_us` values compare only within one boot. macOS: `kern.bootsessionuuid`. Windows: boot time from interrupt time, rounded to seconds. |
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
| `hello` | `helper`, `version`, `pid`, `os`, `permissions`, `config: {heartbeat_s, idle_threshold_s, reconcile_s}`. First line of every run. |
| `heartbeat` | `permissions`, `title_stall_ms` (how long the title thread has been stuck in one call, 0 if not), `dropped` (lines dropped at the queue since start). Sent every `heartbeat_s` from the helper's main event thread, so a stuck event loop stops heartbeats. |
| `app` | `app_id`, `name`, `path`, `pid`, `registered_browser`, `identity_state`, `store`. The front app changed, or reconciliation found a different one. |
| `window` | `pid`, `window`, `title`, `title_state`. The focused window or its title changed. |
| `input` | `state` (`idle` or `active`), `last_input_wall_ms`, `threshold_s`. Input crossed the idle threshold. |
| `session` | `state`: `locked`, `unlocked`, `console_disconnect`, `console_connect`, `remote_connect`, `remote_disconnect`, `logoff`, `logon`. |
| `power` | `state`: `sleep`, `wake`, `wake_automatic`, `display_off`, `display_on`, `display_dim`. `wake_automatic` is a wake without a user (Windows `PBT_APMRESUMEAUTOMATIC` with no following user resume). |
| `clock` | `change`: `time_changed` or `timezone_changed`. |
| `bye` | `reason`. Last line of a clean exit. |

`permissions` is `{accessibility}`, each `granted`, `denied` or `not_applicable`.

`identity_state`: `ok`; `access_denied` (the process could not be queried, identity fields are null); `timeout` (the query hung and was abandoned); `gone` (the process exited first); `none` (nothing is in front).

`registered_browser` is a platform fact, not a decision: the app is registered to open `http` and `https` links. Shared code decides what that means for privacy.

`store` is set for packaged Windows apps: `aumid` (the application user model ID) and `package` (the package full name).

`title_state`: `ok` (`title` is present); `empty` (the window has no title); `no_permission` (Accessibility is not granted); `timeout` (the read hung); `unavailable` (no focused window or the read failed). `title` is present exactly when `title_state` is `ok`, truncated to 1024 UTF-16 code units.

## Contract tests

`fixtures/valid.json` holds one golden line per kind and platform; `fixtures/invalid.json` holds lines the service must reject, with the reason. The TypeScript validator, the Swift encoder and the C# encoder are all tested against these files.
