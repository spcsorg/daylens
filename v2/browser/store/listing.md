# Store listing, permissions and reviewer notes

Shared text for the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. Each store's own fields are in
[chrome.md](chrome.md), [edge.md](edge.md) and [firefox.md](firefox.md). Builds come from `node browser/build.ts`:
`dist/daylens-chromium-<version>.zip` for Chrome and Edge, `dist/daylens-firefox-<version>.zip` for Firefox.

## Name

Daylens

## Summary (132 characters or fewer)

Lets Daylens on this computer see which page you're on, so you can find it again. Never in private windows.

## Description

Daylens remembers what you do on your computer so you can find anything you saw and pick up where you left off. This
extension tells the Daylens app which page you're on, so your day shows the pages you actually read, with the time you
spent on each.

What it does:
- Sends the address and title of the tab you're looking at, in the window you have focused, to the Daylens app on
  your own computer.
- Says "no page" the moment you switch to another app, a private window, or anything else it can't see.
- Lets you pause it for this browser from its button: for an hour, until tomorrow, or until you resume.

What it never does:
- It never runs in private or incognito windows.
- It never reads page content, form fields, passwords or anything you type.
- It never sends anything to a server. Pages go only to the Daylens app on the same computer.
- Before an address leaves the browser, it keeps only web (`http`, `https`) and `file` addresses, and removes: any user
  name and password; the part after `#`; every query parameter whose name contains a word for a token, code, key,
  session, password, secret, signature, authorization or credential; every parameter whose value is a login token
  (`Bearer …`, a `Basic …` user name and password, or a JSON web token); and every parameter whose value is shaped
  like a generated key, unless the parameter names a file, page or video. An address carried inside a parameter, such
  as a return link, even when percent-encoded, is kept only if none of this applies to it; otherwise that whole
  parameter is dropped. Secrets written into the address path itself are not removed.

You need the Daylens app installed on this computer. Without it, the extension does nothing.

## Single purpose

Tell the Daylens app on this computer which page you're looking at, so your day in Daylens shows the pages you read and
how long you spent on each.

## Permission justifications

**tabs**: To read the address and title of the tab you're looking at, only in the window you have focused, and to
notice when you switch tabs or windows. Daylens shows those pages in your day and in search.

**nativeMessaging**: To hand that page to the Daylens app on your own computer. This is the only place the extension
sends anything. Nothing goes to a server.

**alarms**: To try connecting to the Daylens app again after it was closed or restarted, at most every five minutes,
even after the browser has put the extension's background to sleep. It shows no install warning and reads nothing.

**Host permissions**: None. The extension has no content scripts and can't read or change any page.

**Local connection (Windows)**: Where the browser can't reach the Daylens app through native messaging (the Microsoft
Store version of Daylens), the extension connects to the Daylens app at `127.0.0.1` instead. You connect it once from
the extension's button; after that, both sides prove they were connected to each other before any page is sent. This
connection never leaves your computer.

**Remote code**: None. All code ships in the package.

## Data use

The extension handles web history: the address and title of the tab you're looking at. It's sent only to the Daylens
app on the same computer, which stores it on that computer. The developer receives none of it.

- Not sold to anyone.
- Not used or transferred for purposes unrelated to the extension's single purpose.
- Not used or transferred to determine creditworthiness or for lending.

Privacy policy: the public Daylens privacy policy page (required by every store, not published yet).

## Reviewer notes

The extension only works next to the Daylens desktop app. Please use the Daylens desktop build linked in this
submission.

1. Install the Daylens desktop build and open it once. On macOS, allow it when it asks for Accessibility; on Windows
   no permission is needed.
2. Install this extension. Click its button: it says **Connected**.
   - On Windows with the Microsoft Store version of Daylens, it says **Not connected to Daylens**. Click **Connect**
     and allow the browser to open Daylens. It says **Waiting for Daylens…**, then **Connected**. In Firefox it says
     **Allow this browser in Daylens** first: Daylens shows one line asking whether Firefox may connect; click
     **Allow**.
3. Open two or three ordinary pages and switch between them for a minute. In Daylens, open **Today**: the current
   hour lists those pages and the time on each.
4. Open a private or incognito window and visit any page there for a minute. In Daylens, that time shows as browser
   time with no page, and the private page appears nowhere, including in **Search**.
5. Click the extension's button, then **Pause** and **For an hour**. It says **Paused in this browser until** a time.
   Pages you visit in this browser now are not recorded. Click **Resume** to start again.
6. Quit Daylens. The extension's button says **Daylens isn't running** and nothing is recorded.
