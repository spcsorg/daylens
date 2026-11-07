# Blockers only Tonny can clear

Sorted by lead time, longest first. Checked 7 November 2026.

## Decisions that change scope

| ID | Decision | Why it blocks | Recommendation |
|---|---|---|---|
| D1 | **What ships on 20 November: the beta or the release checklist?** | The [release checklist](../docs/build-plan.md#release-checklist) requires the Microsoft Store listing, billing in production, the extension in three stores, a Windows gold day from the Store build, and V1 data opening in V2. Extension review alone can take five weeks. None of that fits before 1 December. | Ship `2.0.0-beta.2` on 20 November against a strict, provable beta gate: notarized macOS, own key or no AI, no accounts. Keep the full checklist as the gate for `2.0.0`. |
| D2 | **Accounts and billing in V2** | The beta promises no accounts, billing or analytics ([privacy](../docs/privacy-and-security.md#in-the-beta)). The finished product has a billing service with accounts, Daylens AI, and analytics on by default. V1's web companion (`irachrist1/daylens` `apps/web`: Next.js, Convex, workspaces, device link codes, recovery, PostHog) is the only account system that exists. | No accounts in the beta. Memo with options follows in `ship/ACCOUNTS.md`. |
| D3 | **Windows: Store only, or a signed installer too** | The docs ship Windows only through the Microsoft Store. Azure Artifact Signing doesn't serve Rwanda (organizations: US, Canada, EU, UK; individuals: US and Canada only), so a direct installer needs a purchased OV certificate. | Store only. |
| D4 | **Domain** | `daylens.app` is still yours. The download page, docs and store listings need one final address. | Renew `daylens.app` (B2). Don't register a new one. |

## Accounts to open (days of lead time)

### B1 · Apple Developer Program: start today

The notarized macOS build needs this, and so does every Gatekeeper-free install. The pipeline is ready: `DAYLENS_MAC_SIGN=1 node app/package/build.ts` signs, notarizes and staples once the four values below exist.

**Fastest compliant path**

1. Check whether SPCS is a registered legal entity with a D-U-N-S number that Apple can find, using the lookup at [developer.apple.com/support/D-U-N-S](https://developer.apple.com/support/D-U-N-S/). The open D-U-N-S task in Notion is for Money Labs Ltd, not SPCS.
2. **If Apple finds it:** enroll as an organization at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/). Use an Apple Account with two-factor authentication on. The legal name must match the registration exactly, the website must be on the organization's domain, and you must have authority to bind SPCS. Pay the $99 a year with the SPCS card so the receipt sits with SPCS for the grant's code-signing line. Expect about 2 business days after Apple's verification call.
3. **If it doesn't:** request the D-U-N-S number on the same page. It's free and takes up to 5 business days, plus up to 2 for Apple to see it, which makes about 18 November the earliest enrollment. That misses 20 November with notarization.
4. **Fallback that makes 20 November:** enroll today as an individual. It costs the same and is usually approved within 48 hours. Gatekeeper and the certificate then show your name instead of SPCS. Pay with the SPCS card, and check that the grant accepts a receipt in your name. Apple Developer Support can move the membership to an organization later; confirm with them that the Team ID carries over, because updates depend on it.

**Hand over once it's active** (as GitHub Actions secrets on `spcsorg/daylens`, never in chat)

- `APPLE_TEAM_ID`
- An App Store Connect API key with the Developer role: the `.p8` file plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
- A Developer ID Application certificate, exported as `.p12`, with its password

### B2 · Renew `daylens.app` before the grace period ends

- The registry already rolled the expiry to 30 October 2027, but the registrar, **Gabia**, has the domain on hold: RDAP shows `auto renew period` and `client hold`, last changed 1 November. It doesn't resolve.
- Renewing during this window costs the normal price. Once the registrar's grace period ends, recovering the domain costs a redemption fee, then it is released. Gabia's window ends 30 to 45 days after 30 October.
- **Steps:** sign in at gabia.com, then My Gabia, Domains, `daylens.app`, Renew, 1 year or more. Turn on auto-renew with a card that won't expire.
- None of the fallback candidates is registered as of today: `getdaylens.app`, `daylensapp.com` and `trydaylens.com`.

### B3 · Microsoft Partner Center: the Store package and the Edge extension

- Registration has been free for individuals since September 2025 and for companies since May 2026. A company account needs registration documents, and verification can take several days.
- **Steps:** register at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/) as SPCS if it is a registered company, otherwise as yourself. Turn on two-factor authentication. Reserve the app name **Daylens**.
- **Hand over:** the Publisher (`CN=…`), the Package Identity Name and the Package Family Name from Product identity. They go into the MSIX manifest.
- The same account publishes the Edge extension.

### B4 · Chrome Web Store and Firefox Add-ons

- **Chrome Web Store:** $5 one-time, at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole). It needs 2-Step Verification. Use a Google group as the publisher so the listing isn't tied to one person.
- **Firefox Add-ons:** free, at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/). Turn on two-factor authentication.
- Store review can take up to five weeks, so the accounts come before the extension is finished.

### B5 · A GitHub Actions budget

- `spcsorg` is on the Team plan, and CI runs: the last run on `main` passed on macOS, Ubuntu and Windows (31 October). The billing notice you saw is on another account; check [github.com/settings/billing](https://github.com/settings/billing) and the `spcsorg` billing page.
- The new harness needs far more minutes: each test run 20 times, packaged E2E on three operating systems, and notarized builds. macOS minutes bill at 10 times the Linux rate.
- **Decide:** a monthly Actions spending limit for `spcsorg`.

### B6 · An Anthropic API key with a spend cap

- **Steps:** in [console.anthropic.com](https://console.anthropic.com/), create a workspace called `daylens-evals`, set its monthly spend limit, and create a key in it. Then run this and paste the key at the prompt:

```bash
gh secret set ANTHROPIC_API_KEY -R spcsorg/daylens
```

- **Tell me:** the cap. Nightly evals stop when they reach it.

### B7 · Test machines

- The [platform matrix](../docs/testing.md#platform-matrix) needs a Windows 11 x64 client desktop in the cloud (not Windows Server) and the physical Windows laptop. macOS and Ubuntu VMs run on this Mac.
- **Decide:** a monthly budget for the Windows cloud desktop, and whether Parallels with Windows 11 on ARM is installed here.

## Settings to change (minutes)

| ID | Where | Change | Found |
|---|---|---|---|
| S1 | `spcsorg` organization: Settings, Authentication security | Require two-factor authentication for everyone | Off. The release checklist requires 2FA on every account that can publish. |
| S2 | `spcsorg/daylens`: Settings, Advanced Security | Turn on secret scanning, push protection and Dependabot security updates | All off. They're free on a public repo. |
| S3 | Apple, Microsoft, Google, Mozilla, Resend, Convex, Vercel | Two-factor authentication on every account that can publish or deploy | Not checked; only you can see these |

## Only you can do these

| ID | What | When |
|---|---|---|
| T1 | Label the gold days in your own words: at least five kinds of day, one held out from all tuning, one recorded on Windows | Before the AI-hours target can be proven. Gold days stay outside this repo. |
| T2 | Record the Windows gold day on the physical laptop from the Store build | After B3 and the first certified Store build |
| T3 | Approve the welcome email, the "beta is out" broadcast, the launch posts and the release notes | Drafts land in Resend and the status repo before beta day |
| T4 | Send the broadcast, publish the posts, submit to the stores, and change repo visibility or DNS | Launch day |
