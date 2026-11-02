# Moving V1 installs to V2

Nothing has been pushed, deployed, released or sent. The code change is a local branch in the V1 repo. The text people will read is in [`V1-TO-V2-DRAFTS.md`](V1-TO-V2-DRAFTS.md), marked as a draft waiting for Tonny's yes.

## What exists today

**V1** is `irachrist1/daylens`, a private repo: version 1.0.45, Electron 34.5.8, Node 20.19.1. The last release, 1.0.44, came out on 3 Jun 2026. It updates in three ways:

| V1 install | Update path | Works today? |
|---|---|---|
| macOS (every release is **ad-hoc signed**: the repo has no Apple signing secrets) | Custom feed `christian-tonny.dev/daylens/api/update-feed`, served by `apps/web` in the V1 repo. V1 downloads the ZIP, checks its SHA-256 and bundle ID, then swaps `/Applications/Daylens.app` and relaunches. | **No.** The feed answers, but its download URLs point at release assets in the now-private repo and return 404. |
| Windows (every release is **unsigned**: no Authenticode secrets) | None. V1 turns built-in updates off on unsigned Windows builds. | No, and it never could. |
| Linux (AppImage, deb, rpm) | electron-updater against GitHub Releases on `irachrist1/daylens` | **No.** The repo is private, so every request returns 404. |

So no V1 install can receive any update right now, not even a final V1 release.

**V2** (`spcsorg/daylens`, public) installs over V1 as the same app: `appId` `com.daylens.desktop`, product name `Daylens`. Today it packages **macOS only**: a universal `Daylens-<version>-mac.zip` and `.dmg` (`v2/app/package/build.ts`). The Windows Store package is build step 1c and doesn't exist yet. Linux is a nightly. No V2 release has been published on GitHub yet.

**Install base** (read-only, from GitHub download counts across all 59 V1 releases): 350 installer downloads in total: 244 Windows `.exe`, 99 macOS `.dmg`, 7 Linux. Downloads aren't installs, and Windows updates count again each time, so the real number is likely tens to low hundreds. V1's PostHog would give a better number, but only a write token is visible, so I couldn't read it.

## The mechanism

**macOS: automatic, through V1's own updater.** Every V1 Mac is ad-hoc signed, so every V1 Mac reads the custom feed. Point the feed at V2's public releases, and V1 shows its normal "update available" banner. When the person clicks Install update, V1 downloads V2's universal ZIP, checks it against the GitHub SHA-256 digest and confirms the bundle ID matches. It then swaps the app in place and opens V2. V1's swap script leaves a real Developer ID signature intact, and V2 then updates itself from `spcsorg/daylens`.

The change (V1 repo, local branch `v1-to-v2`, commit `f9d9853`, only in `apps/web`):
- `_releaseAsset.ts`: releases come from `spcsorg/daylens`. Prereleases are kept, because V2 ships its betas as prereleases; drafts are still left out. A new `macAssetMatches` accepts V2's universal `-mac.` build for any architecture.
- `update-feed/route.ts` and `download/mac/route.ts` use `macAssetMatches`. The site's Mac download button gets V2 too.
- `tests/v2UpdateFeed.test.ts` calls the real feed route with V2-shaped releases. It checks the payload against V1's own `isRemoteUpdateDescriptor` and `compareReleaseVersions` (`2.0.0-beta.N` > `1.0.45`). `tests/support/ts-loader.mjs` now resolves `next/server` the way the web app's bundler does.

**Windows and Linux: no in-app path exists.** There is no V2 Windows build, and V1 on Windows can't update. The only levers are the email (draft 3), the note to the flagged-device owners (draft 4), and the site's Windows button. Point that button at V2's Windows waitlist by setting `DAYLENS_WINDOWS_STORE_URL` on the V1 web project; no code change is needed. **This doesn't meet "nobody stays on Electron 34" for Windows.** The flagged devices were most likely Windows (Defender), and those users can only be asked to uninstall.

**No final V1 release.** It would reach nobody: Mac users get V2 through the feed instead, and Windows and Linux have no working update path.

## What V2 carries over from V1

| V1 data | In V2 |
|---|---|
| Pause, excluded apps, excluded sites (`config.json` in `Daylens Desktop` / `Daylens` / `DaylensWindows`) | **Carried** into a new V2 store (`capture/v1Privacy.ts`). V1 writes these keys through electron-store (`trackingPaused`, `trackingControlsEnabled`, `trackingExcludedApps`, `trackingExcludedSites`), which matches what V2 reads. |
| Activity history (`daylens.sqlite`: app sessions, page visits, idle, lock and sleep) | **Not shown.** V2 never opens V1's database. It stays on disk, untouched, in its own folder. V2 keeps its data in `Daylens V2`. `tools/importV1.ts` converts it, but only as a private evaluation tool that rebuilds a whole database, not as a first-launch import. |
| AI API keys (keychain, service `Daylens Desktop`, via keytar) | **Not carried.** V2 stores its key with `safeStorage` and has no keytar. The person enters it again in Settings → AI. |
| AI chats, generated reports, artifacts, screen-context frames, web companion link | **Not carried.** V2 has no equivalent store for them. |
| Login item | Kept: V2 sits at the same path. |

The release checklist item "V1 users' existing data opens in V2" stays open. The drafts tell people their history is still on disk, not that it will be imported.

## Launch day: Tonny's steps, in order

1. **Decide Windows** (below). Collect the V1 users' email addresses.
2. **Build V2 for Mac, signed and notarized:** `DAYLENS_MAC_SIGN=1 APPLE_TEAM_ID=… APPLE_API_KEY=… APPLE_API_KEY_ID=… APPLE_API_ISSUER=… npm --prefix v2 run app:package`. It must be Developer ID signed. On an ad-hoc V2, the person lands on a build that can't update itself (see risks).
3. **Publish the V2 release** on `spcsorg/daylens` (a prerelease is fine). Upload `Daylens-<v>-mac.zip`, `Daylens-<v>-mac.dmg` and `latest-mac.yml` from `v2/build/release`, and use draft 1 as the release body. Then check that every asset has a digest: `gh api repos/spcsorg/daylens/releases/tags/v<v> -q '.assets[] | .name + " " + .digest'`.
4. **Rehearse on one Mac running V1 1.0.44**, against a preview deployment of the branch: `DAYLENS_UPDATE_FEED_URL=https://<preview>/daylens/api/update-feed /Applications/Daylens.app/Contents/MacOS/Daylens`. V1 reads that variable. Click Install update, then confirm three things: V2 opens and onboarding runs; the pause and exclusions are there; `shasum -a 256 ~/Library/Application\ Support/Daylens\ Desktop/daylens.sqlite` is unchanged.
5. **Deploy the feed:** merge `v1-to-v2` into V1 `main` and deploy `apps/web` to production, the way it's deployed today. From here, every V1 Mac sees the update within 4 hours of being open, or 10 seconds after launch.
6. **Verify production:** `curl 'https://christian-tonny.dev/daylens/api/update-feed?platform=darwin&arch=arm64'`, and again with `arch=x64`, should return version 2.x. Its `installUrl` should download without signing in, and `shasum -a 256` of that file should match `installSha256`.
7. **Windows button:** set `DAYLENS_WINDOWS_STORE_URL` on the V1 web project to the V2 Windows waitlist page and redeploy.
8. **Send** draft 2 (Mac), draft 3 (Windows and Linux) and draft 4 (flagged devices).
9. **Watch** the V2 `-mac.zip` download count over the week, since each one is a V1 Mac that switched, and the V1 web project's logs for feed errors.

## What was tested

- V1 repo: `tests/v2UpdateFeed.test.ts` (3 tests), `updaterReleaseFeed.test.ts` (9) and `webBehavior.test.ts` (5) pass under V1's own runner. The `apps/web` typecheck and eslint on the new test pass. Against the unchanged routes, the feed test returns 404 for a V1 Mac when the releases are V2's. With the change it returns a valid descriptor.
- V1's banner, run through V1's own `extractReleaseHighlights`, shows both draft 1 bullets in full.
- V2: the four V1 carry-over tests in `tests/service.test.ts` pass: pause, exclusions by bundle ID and by shown name, and no history read-in under a V1 pause. The full V2 suite passes on this branch (817 of 827, 0 fail).
- Read-only checks of the live feed (it serves 1.0.44, and its download URLs return 404), the GitHub visibility and the download counts.
- **Not tested:** a real V1 → V2 swap on a Mac. That needs a signed V2 release, which doesn't exist yet, so it's step 4. Nothing was tested on Windows.

## Risks

- **Windows users stay on V1** until V2 for Windows ships. This is the biggest gap, and it's where most V1 downloads were.
- **An unsigned V2 Mac release** gets re-signed ad-hoc by V1's swap. That V2 then can't update through Squirrel and needs a manual install later. Signing is also on the release checklist.
- **A keychain prompt on first launch.** V1 and V2 share the app name, so V2 may ask for V1's "Daylens Safe Storage" keychain item. Denying it can break V2's encrypted storage on that Mac. The drafts say to choose Always Allow. Untested.
- **The update looks like data loss.** An empty calendar after the swap reads as lost history. Draft 1's banner bullets say otherwise before the click.
- **Feed routing.** `/daylens` already serves the V2 launch page, while `/daylens/api/update-feed` still reaches the V1 web project (`x-matched-path: /api/update-feed`). A routing change that sends all of `/daylens` to the new site breaks the migration silently.
- **GitHub API rate limits.** The feed calls the GitHub API on every check. Keep `DAYLENS_GITHUB_RELEASES_TOKEN` set on the web project.
- **The click.** People who never open V1, or never click Install update, stay on V1. The email covers them.
- **V1's other services stay as they are.** V1's web companion, billing and Convex backend are not touched by any of this.
