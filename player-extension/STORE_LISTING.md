# Chrome Web Store — submission for tinv player

Upload: `~/Desktop/tinv-extension.zip`

---

## Name
tinv player

## Summary (short description, max 132 chars)
Plays tiny .tinv videos automatically. Click a .tinv link and it streams inline instead of downloading.

## Detailed description
tinv player makes .tinv videos play instantly in your browser.

A .tinv file is an ordinary video compressed to a fraction of its size.
Normally a browser would just download it. With tinv player installed, clicking
any .tinv link plays it right away in a clean, distraction-free player — with
playback speed, ±10s skip, volume, picture-in-picture, fullscreen, and resume.

Nothing is uploaded. Videos are decoded and played entirely on your device.

How it works:
• Click a .tinv link on any page, and it opens in the tinv player and plays.
• Keyboard shortcuts: Space (play/pause), arrow keys (skip), F (fullscreen),
  M (mute), P (picture-in-picture), < and > (speed).

No account, no tracking, no data collection. Open source.

## Category
Productivity

## Language
English

---

## Permission justifications (the submission form asks for these)

### declarativeNetRequest
Detects when you open a .tinv video URL and redirects it to the extension's
bundled player page so the video plays inline instead of downloading as an
unknown file. The rule only matches URLs ending in ".tinv". No browsing data is
read or sent anywhere.

### Host permissions (<all_urls>)
.tinv links can be hosted on any website, so the redirect rule must match a
.tinv URL on any domain. The extension does not read page content, inject
scripts into pages, or collect any data — it only redirects .tinv navigations
to its own player page.

### Are you using remote code?
No. All code and assets are bundled in the package. The extension makes no
external network requests except fetching the .tinv file the user chose to open.

---

## Privacy

### Single purpose
Play .tinv video files in the browser.

### Data usage
Collects, stores, and transmits no user data. Videos are decoded and played
locally on the user's device. No analytics, no tracking.

### Privacy policy URL
https://tinv.app/privacy

---

## Store assets checklist
- [x] Icon 128×128 — bundled (icons/icon128.png)
- [x] Privacy policy URL — https://tinv.app/privacy
- [ ] At least 1 screenshot, 1280×800 or 640×400 PNG/JPG
      (Open player.html on a .tinv and capture the window.)
- [ ] Small promo tile 440×280 (optional but recommended)

---

## Notes to reviewer (paste into the "Notes to reviewer" field)
The extension's only function is to intercept top-level navigations to *.tinv
URLs and redirect them to a bundled player page (player.html) that decodes and
plays the file locally. It does not read or modify any web page content, and
makes no remote requests other than fetching the .tinv the user opened.

To test: install, then open any URL ending in .tinv (for example a link to a
hosted .tinv file). It will redirect to the bundled player and play.
