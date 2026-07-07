# Dislike for Shorts

A tiny, open-source browser extension that puts a **working dislike button back on
YouTube Shorts**.

In June 2026, YouTube removed the dislike button from the Shorts player. The
dislike action still works fine on regular videos, and the internal endpoint
(`/youtubei/v1/like/dislike`) still accepts requests for Shorts. This extension
re-adds the button to the Shorts UI and sends the dislike through that endpoint
the same call YouTube's own web client makes.

> **Honest status:** early / experimental (`v0.1.0`). A `200` response means the
> request was accepted. It does **not** prove YouTube still factors Shorts
> dislikes into recommendations, that's not verifiable from outside. This tool
> restores the *button and the action*, nothing more is promised.

## Why this approach is more robust

Instead of hacking a fragile bug, the extension leans on a structural fact: the
long-form video pipeline was left untouched by the Shorts redesign. The dislike
call it replays is the standard authenticated InnerTube mutation, not a one-off
exploit.

## How it works

Two scripts, because YouTube's auth/config lives in the page context:

| File | World | Role |
|------|-------|------|
| `src/content.js` | isolated | Detects the active Short, injects the button, handles clicks |
| `src/bridge.js` | main (page) | Reads `ytcfg`, builds the `SAPISIDHASH` header, calls the endpoint |

They communicate through `window.postMessage` (tagged `sd:v1`), not
`CustomEvent`, which Firefox blocks across the isolated/page world boundary.

## Install (developer / unpacked)

**Chromium (Chrome, Edge, Brave, …)**
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

**Firefox**
1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → select `manifest.json`

Then open any Short and look for the 👎 button next to the like button.

## Known fragile spots

- **DOM selectors** in `findLikeButton()` (`content.js`). YouTube rolls out UI
  changes gradually and unevenly, so the injection point may need updating.
  That function is intentionally isolated and commented.
- **Auth header**. If disliking returns `401`/`403`, the `SAPISIDHASH`
  computation in `bridge.js` is the place to debug.

## Roadmap

Done so far:

- [x] Dislike via YouTube's internal `like/dislike` endpoint (confirmed `200` end-to-end)
- [x] Native look + automatic dark mode (matches YouTube's own button)
- [x] Disliked state persists locally and reconciles with YouTube's real server status
- [x] Visible feedback (shake) when a dislike request is rejected

Next:

- [ ] Publish to the Chrome Web Store and Firefox Add-ons
- [ ] Keep the DOM selectors resilient to YouTube's staggered UI rollouts

## Contributing

This is a small project but Issues and PRs welcome.

## License

[MIT](./LICENSE)

---

*Not affiliated with, endorsed by, or sponsored by YouTube or Google. "YouTube" is
a trademark of Google LLC.*
