# Chrome Web Store

Package: `dist/daylens-chromium-<version>.zip`. Arc and Dia install the same item from the Chrome Web Store.

| Field | Value |
|---|---|
| Name, summary, description | [listing.md](listing.md) |
| Category | Productivity |
| Language | English |
| Single purpose | [listing.md, Single purpose](listing.md#single-purpose) |
| Permission justification: `tabs` | [listing.md](listing.md#permission-justifications) |
| Permission justification: `nativeMessaging` | [listing.md](listing.md#permission-justifications) |
| Host permissions | None requested |
| Remote code | No |
| Data usage: categories | Web history |
| Data usage: certifications | All three (not sold, not used for unrelated purposes, not used for creditworthiness) |
| Privacy policy URL | The public Daylens privacy policy page |
| Test instructions | [listing.md, Reviewer notes](listing.md#reviewer-notes) |
| Screenshots | 1280×800 or 640×400; take them from the popup in each state: Connected, Paused in this browser, Daylens isn't running |
| Icon | `extension/icons/icon-128.png` |

The store assigns the item ID on the first upload, before publishing. That ID has to be added in four places before
release: `allowedExtensionIds` in `native/macos/Sources/CaptureCore/NativeMessaging.swift`, `HostLaunch.Allowed` in
`native/windows/Daylens.Capture.Core/NativeMessaging.cs`, `CHROMIUM_EXTENSION_IDS` in `capture/pairing.ts`, and the
`allowed_origins` the installer writes into each Chromium browser's host manifest. Release builds should drop the dev
ID `dgidcofcmgnlicmmepgomalcdcbgjjjg`, whose public key is in this repository.
