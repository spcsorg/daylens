# Billing

## Plans

| | Free | Pro | Your own AI |
|---|---|---|---|
| Recording, Today facts, Search, Apps, history, fixing, deleting | Yes | Yes | Yes |
| Assistants over MCP | Yes | Yes | Yes |
| AI-written hours and Ask answers | Limited each month | A larger allowance with a fair-use limit | Billed by the user's provider |
| Price | Free | Monthly or yearly | Free to Daylens |

Prices are not final. No plan is described as unlimited: every allowance is set so that the plan covers its AI cost. The per-day AI cost budget and the allowances are decided together, from measured cost per named day.

At the free limit, hours stay as facts, Search keeps working, Ask searches instead of answering, corrections keep working, and assistants keep reading. The limit resets each month.

## Usage

- One usage ledger records every AI call: what it was for (writing an hour or answering in Ask), its cost, and the plan it counted against.
- The count shown anywhere in the app comes from that ledger, so every screen shows the same number.
- The billing service is the authority for entitlement; the app caches the last confirmed state and says so if it cannot reach the service.

## Payment methods

- **Card:** the payment provider's hosted checkout. Card numbers never pass through Daylens.
- **Mobile money:** a request sent to the user's phone, approved with their PIN. Mobile money passes do not renew automatically; the app reminds the user before the pass ends.
- Prices are shown in the user's local currency.

## Payment state rules

1. The app shows a payment as succeeded, failed, expired or cancelled only after the payment provider confirms it.
2. Every payment has a pending state with a clear way to wait or cancel.
3. Cancelling a mobile money request shows "cancelling" until the provider confirms. If an approval arrives during cancellation, the user is given the plan or refunded, and told which.
4. Webhooks are processed idempotently: a repeated event never charges, grants or revokes twice.
5. Cancelling Pro keeps Pro until the end of the paid period, then moves to Free. Nothing recorded is lost.
6. A returning user who signs in on a new machine gets their plan back.

## Implementation

`services/billing` provides accounts, entitlements, usage metering through a private model proxy, card subscriptions, and mobile money. The operations runbook is [operations/billing.md](operations/billing.md); it describes V1 and must be checked against these rules before release.
