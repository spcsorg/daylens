# Agent instructions

The app lives in `v2/`; work happens on `main`. Start at [`docs/README.md`](docs/README.md); recorded product decisions live in `docs/`.

## How to work

1. **Fast and working come first.** Launch, paint and every action stay inside the budgets in [`docs/system-design.md`](docs/system-design.md). Measure before and after any change a person can see.
2. **Build the smallest thing that works.** No locks, caches, options or abstractions the feature doesn't need. Push back when a reviewer asks for more.
3. **Leave no dead code.** Delete what your change makes unused: functions, files, exports, styles, flags, tests and docs. No commented-out code.
4. **Test what you touch.** A fix comes with a test that fails without it. Run `npm test`, `npm run typecheck` and `npm run app:typecheck` in `v2/`. Check screens in the running app, filled with invented data from `v2/app/tools/seed.ts`.
5. **Build for macOS, Windows and Linux.** A change that only works on one platform says, in its PR, what the other two get and what was tested on each.
6. **Decide where the docs are silent.** Do what established products do, record the decision in the matching doc under `docs/`, and list it in the PR. Ask only when there is no common practice, or the step is irreversible or public.
7. **Never fail silently.** If a person clicks something and it fails, the UI says so.
8. **Comment only what the code can't say**: a constraint, workaround or gotcha, in one line. No narration, dates or names.
9. **No personal data.** This repo is public. No real activity, window or page titles, names, file paths, dates of real days, or screenshots of a real day, in code, tests, fixtures, docs, commits or PRs. Use invented data.

## How to ship

Every change goes in on full send, into `main`, using the tstack skills ([github.com/t3dotgg/tstack](https://github.com/t3dotgg/tstack)):

- **Branch** from the latest `main`, in its own worktree, named for the change (`today-week-colors`). No tool or model prefix.
- **Review** with `sol-loop`: `codex exec`, or `droid exec` when Codex is at its limit.
- **File** with `file-pr`. **Watch** with `babysit-pr`. **Comment** with `leaving-pr-comments`.
- **Merge** with `full-send`, or stop at ready with `full-stop` when asked.
- Push only to the `spcsorg` remote.
- No AI attribution in commits, PRs, comments or releases.
- Every check must pass.
- After anything merges into `main`, rebase open branches before carrying on.

A release ships only when every item in the [release checklist](docs/build-plan.md#release-checklist) is done and proven. No agent skips one.

Edits to this file or any doc are listed in the PR description.
