# Plaintext API key in the legacy app-data directory

Recorded 2026-08-11. No key material appears in this document.

## What was found

A real-format Anthropic API key stored in cleartext as an ordinary application
setting.

| Field | Value |
| --- | --- |
| Path | `~/Library/Application Support/Daylens/config.json` |
| Size / mtime | 186 bytes, 2026-04-01 18:22 |
| Setting name | `anthropicApiKey` |
| Format | `sk-ant-api03-…`, 108 characters — matches the live key format, not a placeholder |
| Identifying prefix | `sk-ant-api03-m` |
| SHA-256 of the value | `c2af827ad249f6223d8523928efd6758f98d70cabda5dcac03745d7e85ab12d8` |
| Other settings in the file | `launchOnLogin`, `trackingEnabled` |

The prefix and hash are recorded so the key can be identified in the Anthropic
Console without the value existing anywhere in the repository.

The directory belongs to the **legacy GRDB-era application**, which persisted
provider keys through electron-store like any other preference. The current
application's user-data directory is
`~/Library/Application Support/DaylensWindows`, and its config holds 60 settings
and **no** provider secret of any kind — keys go to the OS secure store via
keytar (`services/secureStore.ts`, `settings.setApiKey`).

## Scope

| Location | Result |
| --- | --- |
| Git history, all branches (`git log --all -S`) | **Clean.** One long-form literal exists, in `tests/mcpTools.test.ts` — 37 chars, hash distinct from the real key. It is the secret-sanitization fixture. |
| Repository tracking | `config.json` was never tracked. |
| Working tree | No real-format key. Matches in `providerValidation.ts`, `aiProvider.ts`, `apps/web/**` and four test files are prefix checks and fixtures. |
| `.env`, `.env.local`, `logs/` | No matches. |
| Current app config (`DaylensWindows/config.json`) | No `anthropicApiKey`, no provider secret. |
| Time Machine / backup volumes, generated history exports | **Not checked** — outside what was searched. |

## Remediation

| Action | State |
| --- | --- |
| Local plaintext copy deleted | **Done** — `~/Library/Application Support/Daylens/config.json` removed |
| Regression guard added | **Done** — `tests/noSecretsInSettingsStore.test.ts` |
| Architecture note corrected | **Done** — `docs/codebase/architecture.md` |
| **Revoke the key in the Anthropic Console** | **Outstanding — owner action** |

Revocation was not performed here: it requires authenticating to the Anthropic
Console, which is not an action this agent takes on the owner's behalf. The key's
credits are reportedly exhausted, which lowers the urgency but does not close the
issue — an exhausted key becomes live again the moment credits are added.

Revoke the key with prefix `sk-ant-api03-m` at console.anthropic.com → API keys.

## The regression guard

`tests/noSecretsInSettingsStore.test.ts` asserts four things about the settings
store, which is the surface that leaked:

1. No settings key is *named* like a credential (`apiKey`, `secret`, `token`,
   `password`, `bearer`, `credential`, `privateKey`).
2. No settings default *holds* a secret-shaped value (Anthropic, OpenAI, Google,
   OpenRouter, GitHub token formats).
3. `anthropicApiKey` is not a setting and cannot become one again.
4. `setApiKey` never degrades to the settings store — with no secure store
   available it throws rather than persisting the value as a preference.

## Note on provider configuration

Unrelated to the exposure, and relevant to whether the dead key blocks anything:
this install runs `aiProvider = claude-cli` and `aiChatProvider = claude-cli`,
and `selectJobProvider` routes every non-chat job on `aiProvider`. No AI surface
depends on the stored Anthropic key. The `anthropic` values on
`aiBlockNamingProvider` / `aiSummaryProvider` / `aiArtifactProvider` are dead
settings that nothing reads.
