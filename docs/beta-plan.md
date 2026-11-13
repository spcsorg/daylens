# Beta work

The next beta is a working Mac app first. Windows work must name what has actually been tested; a green shared-engine job is not proof of a working Windows app. Linux stays a development target until capture and packaging work there.

The three acceptance paths are a new install reaching its first recorded day, accurate capture with a connected browser extension and editable hours, and Ask giving grounded answers with useful interactive views. Ask must also help without a key. No claim that Ask works completely is made from a small evaluation set.

## Scope and approval

Use the person's own AI key, or no AI. Accounts, billing, usage analytics, screen recording and audio stay outside this beta. Their full-release requirements remain in the build plan. The beta has no promised launch date.

Open pull requests for review. Merging, publishing a release, deploying the V1 download or update routes, store submissions, signing identities, DNS and account or repository settings all need the maintainer's approval. Never enable automatic merging.

## Existing branches

| Branch | Disposition and order |
| --- | --- |
| `ship/coordination` | Keep as the detailed audit ledger. Its seven proven items are historical evidence, not a fresh verification. Some status prose is stale; use the running code and the acceptance tests to settle it. Its scope recommendations and multi-agent process do not override this plan. |
| `test-clock-and-world` | Carry into `beta-harness` first. A shared isolated world and clock are prerequisites for repeatable screen checks. Keep release checks on a clean test desktop: they intentionally start the real native helper. |
| `e2e-playwright` | Finish on `beta-harness` after the clock foundation. Reject hidden target containers, save screen evidence and state the remaining startup-error, native-menu, Windows and installed-app gaps. This is partial screen proof, not an install test. |
| `skips-link-ship` | Keep; review independently after the screen harness. Runtime skip reasons should identify the acceptance gap they leave. |
| `heavy-world-bench` | Keep after the clock foundation. Establish a packaged baseline on a quiet machine before using it as a performance gate. Do not claim the reference-machine budgets from a development Mac. |
| `nightly-flakes` | Keep its parser and tests. Start manually; agree the Actions budget before enabling 80 scheduled jobs. Reconcile its setup with the skip-check branch first. |
| `claude/electron-upgrade-b9d047` | Separate the runtime upgrade from the migration notes. Verify the new runtime with the finished screen harness, native helpers and packaging; do not combine an Electron upgrade with capture or onboarding redesigns. |
| V1 `v1-to-v2` | Hold deployment. Its universal Mac asset matching is useful, but offering every prerelease to existing installs needs an explicit rollout choice. Rehearse V1 to signed V2, verify preserved privacy settings and untouched old history, and explain what history is not imported before approval. |

Keep the original pushed branches until their replacement PRs are accepted. Rebase dependent work after an approved merge.

## Product work after the harness

1. Add editing inside an open hour, showing its recorded sources underneath. Save through the existing single writer, keep corrections across rewrites, show Edited, and offer Undo both immediately and after reopening the hour. Check Today, Search, Ask and MCP against the same corrected record.
2. Register the installed Mac native-messaging host at a stable installed path, then prove a fresh extension connects and its normal-window pages reach the calendar. Store IDs and clean-install evidence remain separate gates. Never count a source-run registration test as installed-app proof.
3. Make onboarding explain permission denial and recovery and lead to useful recorded facts. Test a fresh profile with invented history as well as an empty profile.
4. Exercise real-key Ask and hour writing on invented data, including error recovery, citations, timelines, totals, page and hour lists, and follow-ups. Add a failing gold case before each fix. Inspect the rendered answers, not only the model's output.
5. Wire and package Windows capture, then run it on Windows 11. Shared tests on Windows Server do not establish desktop capture, privacy, installation or update behavior.

Apple enrollment and notarization credentials, domain renewal, store identities, private labeled gold days and launch-copy approval remain maintainer tasks. Secrets never belong in this plan, fixtures or pull requests.
