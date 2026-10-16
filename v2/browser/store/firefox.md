# Firefox Add-ons (addons.mozilla.org)

Package: `dist/daylens-firefox-<version>.zip`. Source package: `dist/daylens-firefox-source-<version>.zip`.

| Field | Value |
|---|---|
| Add-on ID | `browser@daylens.app` (permanent once published) |
| Minimum version | Firefox 140 |
| Data collection | Declared in the manifest: `browsingActivity`, required. Firefox shows this in its own install prompt. |
| Name, summary, description | [listing.md](listing.md) |
| Categories | Other, Privacy & Security |
| Privacy policy | The public Daylens privacy policy page |
| Notes to reviewer | [listing.md, Reviewer notes](listing.md#reviewer-notes), plus the build steps below |
| Source code | Required, because the shipped JavaScript is compiled from TypeScript |

## Build steps for the reviewer

The shipped files are the TypeScript sources compiled by `tsc`, unminified, with comments kept.

1. Unzip the source package. Install Node 24 or later.
2. In the unzipped folder: `npm ci`, then `node browser/build.ts`.
3. `browser/dist/daylens-firefox-<version>.zip` matches the uploaded package file for file.

Firefox gives each install a random `moz-extension://` origin, so the local connection cannot pin the add-on the way
it pins the Chromium IDs. On Windows, Daylens therefore asks once, in the app, whether Firefox may connect, and accepts
no page before the person clicks Allow.
