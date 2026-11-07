# Accounts in V2

Decision D2: whether V2 ships with sign up, sign in and sign out.

## What exists

- **V2 app:** no accounts. AI runs on the person's own key or not at all. Nothing leaves the computer except AI calls the person turns on.
- **V2 docs:** accounts belong to the billing service. It issues Daylens AI tokens, plans and payments, and stores no activity. The docs say "V2 doesn't include it yet" ([Billing](../docs/billing.md#implementation)). Sign-in options are drawn per platform ([Experience](../docs/experience.md#platform-differences)): Apple, Google and email.
- **The beta's promises:** no accounts, no billing, no usage analytics ([Privacy](../docs/privacy-and-security.md#in-the-beta)). The waitlist site repeats this.
- **V1's web companion** (`irachrist1/daylens` `apps/web`): Next.js on Convex, with workspaces, device link codes, remote snapshot sync, encrypted keys, recovery and PostHog. It syncs a person's day to a server. V2's privacy page rules that out: "There is no Daylens cloud copy of anyone's day."

## Options

| | A. No accounts in V2.0 | B. Accounts with Daylens AI and billing | C. Bring V1's companion across |
|---|---|---|---|
| What a person gets | Everything except Daylens AI. AI on their own key. | Sign in, a free allowance, Pro, card and mobile money | Phone access to their day |
| Privacy promises | All kept | Kept: the account holds plan and usage, never activity | Broken: a server copy of the day |
| Work | None | A billing service, auth, token issuing, metering, two payment providers, plan screens, and the abuse, security and E2E work stream C describes | Rewrite against V2's data model, plus a new privacy page |
| Earliest | 20 November | Weeks after the stores and signing are done | Not before B |
| Risk at launch | People without a key get facts only, no written hours | A payment or entitlement bug charges real people | A breach exposes people's days |

## Recommendation

**A for the beta and V2.0. B as V2.1, built against the payment-state rules in [Billing](../docs/billing.md). Never C.**

Without a key, the facts calendar, Search, Apps, MCP and the extension all work. The beta's own promises then stay true word for word. B is the honest route to Daylens AI, and it's what the docs already describe. It needs its own launch gate: billing in production, webhooks confirmed, and prices set. That gate is already in the release checklist.

## If you choose B now

Stream C opens with: the billing service (a Convex project or similar; no activity ever stored), sign-in with Apple, Google and email, short-lived Daylens AI tokens, the usage ledger, card checkout, mobile money, the Plan tab, sign out clearing every token, account deletion, rate limits, and Playwright across every path. The release checklist's "Billing in production mode" item then blocks V2.0.
