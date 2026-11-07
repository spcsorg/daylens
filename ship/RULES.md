# Rules for every agent

Every agent working on V2 gets this file in full. `AGENTS.md` still applies; where the two differ, the stricter rule wins.

## The loop

1. A queue of items from `SHIP.md`, one stream at a time.
2. For each item: **1 implementer**, then **2 adversarial reviewers**, then **1 fixer**, then the gates, then the merge.
3. The implementer never reviews. A reviewer never implements.
4. Each reviewer runs in its own context. It gets only the diff and the SHIP item with its acceptance test, never the implementer's reasoning. Its instruction: assume the code is wrong and find out how.
5. **Gates:** tests, evals, performance ratchets and the visual diff, green on macOS, Windows and Linux. CodeRabbit and both reviewers must clear it.
6. **Small PRs.** Every PR a person could see gets before-and-after screenshots.
7. **Done means proven.** An item is done only when its acceptance test passes in CI or on the clean VM and a separate verifier reruns it. A PR's own test report doesn't count. The verifier also confirms the tests actually ran and weren't silently skipped.

## Before a large change

Write the rules for it first, have them reviewed adversarially, then do a trial run on 3 items before fanning out.

## Tests and evals

- The tests are the oracle and don't depend on the implementation.
- Never stub, skip, weaken or delete a test or an eval to reach green.
- "Make it compile" or "make it pass" never becomes "stub it out".
- A flaky test is a bug, with its own SHIP item.
- Hill-climb the evals; don't overfit them. Add a gold case for every real failure before fixing it.

## Code

- Reject any change that needs a paragraph-long comment to justify a workaround. If it takes a paragraph to explain why it's fine, the code is wrong.
- When output is wrong, fix the process that produced it (the prompt, the loop, these rules) instead of hand-patching the output. Record why here.
- Anything a person could see changing goes behind a short-lived flag, with before-and-after screenshots for Tonny to rule on.
- Unit tests come before optimizations.
- Never loosen a performance budget. Only Tonny can, with data.

## Git

- One worktree per stream, under `.claude/worktrees/<stream>`, on a branch named for the change, with no tool or model prefix.
- Never run `git stash`, `git reset`, `git checkout .`, `git rebase` on a shared branch, or a force-push to `main`.
- Commit only your own files.
- No AI attribution in commits, PRs, comments or releases.
- Push only to `spcsorg`. After anything merges into `main`, rebase open branches before carrying on.
- Run slow commands (full builds, the full test suite) once per batch, not in every agent.

## Data and secrets

- Never use Tonny's real data. Use `npm run demo` or a throwaway profile, and point `HOME`, `DAYLENS_SHELL_DIR` and the history and agent folders at a temporary folder.
- No real activity, names, file paths or dates of real days anywhere in the repo. It's public.
- API keys come from the environment only. Never commit, log or paste them.

## Only Tonny does these

Sending email to real people, public posts, payments, store submissions, repo visibility, DNS, and anything legal or financial. Prepare each one completely, add it to `BLOCKERS.md`, and keep going.

## Resources

Isolate heavy jobs with hard limits. Watch disk, IOPS and spend. If the machine's load average stays above its core count, run fewer agents.

## Learned along the way

| Date | Rule | Why |
|---|---|---|
| 2026-11-07 | Driving the demo: open it with `--remote-debugging-port=9333 --inspect=9229`. Open Search through the main process, not a key press. | Cmd+K is a native menu accelerator, so Playwright key presses never reach it, and macOS blocks synthetic keystrokes. |
| 2026-11-07 | Measure only on a quiet machine, on the packaged build. | The first bench ran at load average 45 and read 7.9 s to Today. That's useless as a baseline. |
| 2026-11-07 | A green Windows CI job doesn't mean Windows works. | CI runs only the shared engine tests. The Windows app doesn't start the Windows helper, and there's no Windows package. |
| 2026-11-07 | Acceptance tests check what actually happens: request bodies, packets, bytes on disk. Never the text that describes it. | The first SHIP draft proved the AI disclosure by comparing two pieces of text, and egress through a proxy that native code bypasses. Both reviewers caught it. |
| 2026-11-07 | Store and installer behaviour is tested from the installed package, never from source. | MSIX virtualizes HKCU and AppData, so native-host and MCP config writes can pass from source and fail installed. |
