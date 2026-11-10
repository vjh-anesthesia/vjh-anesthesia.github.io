# VJH Anesthesia: Today

The Today page of the Vernon Jubilee Hospital Department of Anesthesia: where every member is on any day, and who is on call right now. Version 3.0, November 2026.

## How it works

This repository is a static site served by GitHub Pages. It holds no schedule, no names and no keys. Each member opens the page with a personal link of the form

    https://<this site>/#k=<their key>

The key follows the `#`, which browsers never send to GitHub. The page asks the department's calendar service (a Google Apps Script web app reading the schedule Sheet) for the schedule with that key, and draws it in the browser. Without a valid key the service returns nothing.

On the phone, the page keeps the key and the last schedule it read (browser storage for this site only), so it opens straight away and still works without a signal; it always says when the schedule on screen was read. A refused link (retired, or its owner no longer on the schedule) erases both.

## Files

| File | What it is |
|---|---|
| `index.html` | The page, with its Content Security Policy: scripts, styles, images and fonts from this site only, and connections to Google's Apps Script hosts only |
| `app.js` | Everything the page does. The calendar service's address is `SERVICE` near the top |
| `app.css` | Layout and colours (the palette of the app icon) |
| `sw.js` | Keeps a copy of these files so the page opens offline. Never sees the schedule |
| `manifest.webmanifest` | Android's install details and icons. Given only to browsers that install from it; iPhones use `icons/apple-touch-icon.png` |
| `icons/`, `img/` | App icons, and the laryngoscope that lights the on-call band |
| `fonts/` | Atkinson Hyperlegible Next, under the SIL Open Font License (`fonts/OFL.txt`) |

## Updating

Replace a file through GitHub's web editor or Upload files; GitHub Pages republishes within a minute or two. After changing `app.js` or `app.css`, raise the `?v=` number where `index.html` loads them, and the same names and `CACHE` in `sw.js`, so phones pick up the change promptly.
