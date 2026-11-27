# Windows Store package

On Windows, Daylens ships only through the Microsoft Store, as a full-trust MSIX whose only restricted capability is `runFullTrust`. The Store signs what is uploaded and installs its updates.

The package builds and passes the App Certification Kit in CI under a throwaway identity. It has not been submitted to the Store, has no Partner Center identity yet, and hasn't been tested on a Windows 11 client.

## Building it

On Windows x64, from `v2/`, with the three identity values from Partner Center:

```powershell
$env:DAYLENS_STORE_IDENTITY_NAME = '<Package/Identity/Name>'
$env:DAYLENS_STORE_PUBLISHER = '<Package/Identity/Publisher>'
$env:DAYLENS_STORE_PUBLISHER_DISPLAY_NAME = '<Package/Properties/PublisherDisplayName>'
npm run app:package
```

The build stops and names any value that is missing. It writes `build/release/Daylens-<version>-win-x64.msix`, unsigned, which is the file to upload. `--dir` and `--test` stop at the app folder and need no identity.

## Partner Center values

All three are on the app's **Product management › Product identity** page, which appears once the name is reserved.

| Variable | Partner Center field | Looks like |
|---|---|---|
| `DAYLENS_STORE_IDENTITY_NAME` | Package/Identity/Name | `12345Publisher.Daylens` |
| `DAYLENS_STORE_PUBLISHER` | Package/Identity/Publisher | `CN=00000000-0000-0000-0000-000000000000` |
| `DAYLENS_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName | the publisher name on the developer account |

The Store refuses a package whose identity differs from these. The package version is the app's version with a fourth part of `0`, as the Store requires, so every submission needs a higher app version than the last.

## What the package declares

The manifest is `v2/app/package/appxmanifest.xml`; the logos are `v2/app/package/appx/`, drawn from `build/icon.png` by `appx.py`.

- `runFullTrust`, the only capability.
- A startup task, which Windows enables at the first launch. Settings › General sends the person to Windows Settings › Apps › Startup, because only Windows can turn a startup task back on.
- The capture helper, `daylens-capture-windows.exe`, as a full-trust process.
- The app execution alias `daylens.exe`. Settings › Assistants starts the MCP server through it: its path survives updates, while the install folder changes with each version, and it runs inside the package, so the server reads the record the app writes there. Windows keeps the package's writes under `%APPDATA%` inside the package too, so Claude and VS Code, whose MCP settings live there, aren't connected in one click; they take the copied setup.
- The `daylens:` link scheme, which a Store package can register only in its manifest.

Updates come from the Store, so the built-in updater stays off on Windows. The browser extension connects over `127.0.0.1` rather than native messaging (see [System design](../system-design.md)).

## How CI proves it

The `windows-store` job in `.github/workflows/e2e.yml` builds the package with a throwaway identity (`Daylens.Test`, `CN=Daylens Test`) signed by a self-signed certificate trusted only on the runner. It runs the Windows App Certification Kit and fails on anything but an overall pass, installs the package with `Add-AppxPackage`, starts it from Start, checks that the capture helper runs from the package, and asks the MCP server for `get_status` through the alias (`v2/app/package/checkStore.ts`).

## `runFullTrust` justification

Paste into Partner Center's submission options, under **Restricted capabilities**:

> Daylens is a desktop app that records which apps and windows a person uses so it can show them a calendar of their day, stored only on their own computer. It needs runFullTrust for two things a sandboxed app cannot do. First, it reads the foreground window: which app is in front and its window title, using the Win32 foreground-window, window-text and WinEvent APIs, as the person switches between apps. Second, it runs its capture helper, a separate full-trust process included in the package, which watches for foreground, title, idle, lock and sleep changes and reports them to the app. Nothing is read from private or incognito browser windows, recording can be paused or limited at any time, and nothing leaves the computer unless the person adds their own AI provider key, which Daylens then uses to write their hours and answer their questions, or connects an AI assistant that reads their day.
