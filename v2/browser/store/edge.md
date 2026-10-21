# Microsoft Edge Add-ons

Package: `dist/daylens-chromium-<version>.zip` (the Chrome build; Edge needs no changes).

| Field | Value |
|---|---|
| Name, summary, description | [listing.md](listing.md) |
| Category | Productivity |
| Markets | All |
| Privacy policy URL | The public Daylens privacy policy page (Edge requires it because the extension handles web history) |
| Notes for certification | [listing.md, Reviewer notes](listing.md#reviewer-notes), plus: on Windows the Microsoft Store version of Daylens uses the local connection, so the reviewer sees **Not connected to Daylens** first and clicks **Connect** |
| Permission justifications | [listing.md](listing.md#permission-justifications) |
| Store logo | `extension/icons/icon-128.png` (Edge asks for 300×300; export it from the source artwork) |
| Screenshots | 1280×800 or 640×480, the same popup states as Chrome |

Edge Add-ons assigns its own extension ID, different from the Chrome Web Store's. It goes in the same four places as
the Chrome ID (see [chrome.md](chrome.md)); on Windows the installer writes it into
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\app.daylens.browser`.
