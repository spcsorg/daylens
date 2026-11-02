# V1 → V2: user-facing text

**Draft, waiting for Tonny's yes.** Nothing here has been sent, posted or published.

## 1. V2 release notes (the GitHub release body on spcsorg/daylens)

V1's update banner shows the first two bullets under `## Highlights`, cut at 150 characters, so those two are written for V1 users. Paste as-is.

```markdown
## Highlights
- This installs Daylens V2, a new app that replaces the one you have. Your pause and the apps and sites you keep out come with you.
- Your V1 history stays on this Mac, untouched, but V2 doesn't show it yet. You'll add your AI key again in Settings.

## What to expect the first time it opens
- Daylens walks you through setup again. macOS asks you to allow Daylens in Accessibility, because V2 records through a new helper.
- macOS may ask whether Daylens can use "Daylens Safe Storage" in your keychain. Choose Always Allow.
- Your V1 AI chats, reports and the web companion link don't carry over.

## Why
V1 runs on Electron 34, which no longer gets security fixes, including the fix for a known Brotli flaw in Node (CVE-2026-111497). V2 runs on a supported release.
```

## 2. Email to V1 users on a Mac

**Subject:** Daylens V2 is here, and it replaces V1

Hi,

Daylens V2 is out today. It replaces the Daylens you have, and V1 won't get any more updates. V1 runs on an Electron version with a known security flaw that is no longer fixed, so please move over this week.

The next time Daylens is open, it will offer the update. Click Install update and it restarts as V2. You can also download it here: {V2 Mac download link}.

What comes with you: your pause, and the apps and sites you keep out of the record.

What doesn't, yet: V2 doesn't show your V1 history. It stays on your Mac, untouched. You'll also enter your AI key again in Settings, and V1 chats and reports don't carry over.

The first time V2 opens, it walks you through setup. macOS asks you to allow Daylens in Accessibility, and may ask about its keychain item. Choose Always Allow.

Reply to this email if anything goes wrong.

Tonny

## 3. Email to V1 users on Windows (and Linux)

**Subject:** Please uninstall Daylens V1 for now

Hi,

Daylens V1 for Windows has reached its end. It runs on an Electron version with a known security flaw that is no longer fixed (CVE-2026-111497), and it can't update itself. Please uninstall it this week: Settings → Apps → Installed apps → Daylens → Uninstall.

Uninstalling leaves your recorded history on your PC. Nothing is deleted.

Daylens V2 for Windows isn't ready yet. {Join the Windows list here: link}, and I'll write when it is.

Sorry for the gap.

Tonny

## 4. Short note to the people whose devices were flagged

Hi, your laptop was flagged for Daylens V1 (Electron 34 / Node 20, CVE-2026-111497). V1 won't get a fix. Windows: please uninstall it (Settings → Apps → Daylens → Uninstall). Your history stays on the laptop. Mac: open Daylens and click Install update, which moves you to V2. Thanks, Tonny
