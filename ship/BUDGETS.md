# Budgets

Every number is p95 unless marked otherwise, measured on the packaged app with the reference data. A budget can be tightened as soon as the baseline beats it. Only Tonny can loosen one, and only with data.

**Reference machines:** a MacBook Air M1 with 8 GB · a 4-core Windows 11 laptop with 8 GB · Ubuntu 24.04 on 4 vCPUs with 8 GB.

**Reference data:** the demo world scaled to 90 days of a heavy user: 12 hours a day, 40 apps, 3,000 page visits a day, and agent sessions.

## First baseline

7 November 2026. This is a smoke reading, not the baseline.

- **Machine:** M2 Pro, 16 GB, load average 45 from parallel builds.
- **Build:** dev, not packaged.
- **Data:** the demo world, three weeks and 2.3 MB, not the 90-day reference.
- **Method:** `node app/tools/bench.ts --runs 5`. The bench reports medians and maximums, not p95.

The real baseline is taken when I-0 is done: the packaged app, a quiet machine, the 90-day world, and p95.

| ID | Measure | Budget | Smoke reading (median / max) | Bench |
|---|---|---|---|---|
| I-0 | 90-day heavy-user world and a p95 bench on the packaged app | exists | ❌ The seed is 3 weeks; the bench has no p95 and no packaged runs in CI | `app/tools/seed.ts`, `app/tools/bench.ts` |
| I-1 | Cold start to an interactive Today | ≤ 800 ms on Mac, ≤ 1.2 s on Windows and Linux | 7,915 / 9,230 ms launch to Today; 2,588 / 3,022 ms renderer navigation to Today | `launch_to_today_ms` |
| I-2 | Opening from the menu bar or tray, warm | ≤ 150 ms to first paint, ≤ 250 ms to interactive | not measured | ❌ |
| I-3 | Any click or keypress to a visible response | ≤ 50 ms; p99 ≤ 100 ms | switch day 23 / 36; open hour 24 / 189; back to Today 18 / 288 ms | `switch_day_ms`, `open_hour_ms` |
| I-4 | Switching between Today, Search, Apps and Settings | ≤ 100 ms fully rendered; 0 layout shifts after paint | Apps 23 / 27 ms; week 47 / 69; month 41 / 67. Layout shifts not measured | `apps_view_ms`, `week_view_ms` |
| I-5 | Scrolling a full day, and streaming Ask answers | 120 fps on a 120 Hz display; 0 frames over 16.7 ms | not measured | ❌ Needs DevTools begin-frame control |
| I-6 | Search across 90 days | ≤ 100 ms to results; ≤ 8 ms main-thread work per keystroke | 3–17 ms median, 137 ms max, on three weeks | `search_*_ms` |
| I-7 | Ask: local retrieval | ≤ 150 ms | not measured | ❌ |
| I-8 | Ask: first streamed token, real key | ≤ 2 s | not measured ⛔ B6 | ❌ |
| I-9 | Capture event to durable storage | ≤ 100 ms | not measured | ❌ |
| I-10 | Capture CPU | average ≤ 0.5%; p99 ≤ 5% | not measured | ❌ |
| I-11 | Memory | helper ≤ 50 MB; app idle ≤ 200 MB | capture and backfill stay under 135 MB in Electron Node mode | `tests/agents/memory.test.ts` (macOS only) |
| I-12 | Disk use for the reference user | ≤ 50 MB a month | not measured | ❌ |
| I-13 | Battery | macOS Energy Impact "Low" while recording | not measured | ❌ |
| I-14 | 72-hour soak | 0 crashes; memory growth ≤ 5% | not measured | ❌ |
| I-15 | Deletion | UI responds in ≤ 100 ms; a disk scan finds nothing | not measured | ❌ See A-7 |
| I-16 | Install | first launch to recording ≤ 2 minutes on every OS; only the standard first-open dialog, no Gatekeeper or SmartScreen warning | not measured | ❌ See N-6 |
| I-17 | The calendar never waits | With AI and network throttled, day, week and month paint facts within I-1 and I-4 | not measured | ❌ |
| I-18 | An hour is written after it ends | Within 10 minutes, in the background | 5-minute delay in code (`hourWriter.ts:13`); not measured | ❌ |

## Quality

| Measure | Bar | Baseline |
|---|---|---|
| Tests | 0 failing, 0 flaky, 0 skipped without a SHIP item, on every OS | macOS, 7 November: 827 of 827 Node tests passed, 0 skipped, in 238 s; 44 of 44 Swift tests passed. Windows and Linux: green in CI on 31 October with 18 platform skips. Flakiness not measured |
| Typecheck | clean | `npm run typecheck` and `npm run app:typecheck` clean, 7 November |
| AI-written hours | ≥ 95% hour-eval pass across 5 runs; 0 unsupported claims on the gold set; every statement cited | not run ⛔ B6 |
| Ask | 100% grounded in cited evidence; correct refusal without evidence | not run ⛔ B6 |
| Security | 0 critical or high advisories in shipped dependencies | not run |
| Privacy gate | 0 bytes stored while paused, excluded or past retention, across every capture path | example tests pass; property tests don't exist |

## Rules for benches

- Prefer deterministic counters to wall-clock time: instruction counts, React commits per interaction, style recalculations, DOM mutations, and layout shifts by named region. Prove that each one tracks wall-clock time, and delete any that doesn't.
- Every bench is also a CI ratchet: CI fails above the ceiling, and a daily job lowers the ceiling whenever the number improves.
- Hitting a budget isn't the end. Set the next target, and stop only when the gain isn't worth the complexity, with Tonny's agreement.
