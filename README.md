# tinv

Tiny tutorial videos. **Encode once, play anywhere, share with one link.**

A `.tinv` file is a small AV1+Opus video wrapped in an obfuscated container — it
does **not** play in a plain browser, only in the tinv players. Metadata (title,
chapters, compression stats) is embedded, so it's a single file.

---

## Quickstart

**Just want to play a `.tinv`?** Open it in the web player:

```
https://tinv.app/?url=https://your-host/lecture.tinv
```

**Want to make one?** Convert a video with the CLI:

```bash
node cli/convert.js lecture.mp4        # → lecture.tinv
```

---

## How it works (end to end)

```
1. CONVERT   video.mp4  ──▶  lecture.tinv      (CLI, or the PWA's Convert tab)
2. HOST      upload lecture.tinv to any static host with CORS (R2, S3, Pages…)
3. SHARE     https://tinv.app/?url=<that hosted URL>
4. PLAY      anyone opens the link → plays in the browser, nothing to install
```

A `.tinv` is tiny, so hosting and bandwidth are cheap. The viewer never installs
anything; the file streams and decodes in their browser.

---

## The pieces

| Folder | What it is |
|--------|------------|
| **`cli/`** | Node converter — wraps a bundled ffmpeg (SVT-AV1) to make `.tinv` files. The fast path for large videos. |
| **`player-web/`** | The PWA — plays `.tinv` and can convert small videos in-browser (native WebCodecs AV1, Chromium only). Live at **https://tinv.app** |
| **`player-extension/`** | Chrome/Edge extension — auto-plays `.tinv` links you click on the web. |

```
tinv/
├── cli/
│   ├── convert.js          # Node converter (SVT-AV1)
│   └── ffmpeg/             # bundled ffmpeg + ffprobe (git-ignored)
├── player-web/             # the PWA (deployed to Vercel)
│   ├── index.html  app.js  player-core.js  style.css
│   ├── convert.js          # in-browser encoding (native WebCodecs AV1)
│   ├── tinv-format.js      # .tinv encode/decode (shared everywhere)
│   ├── embed.html  privacy.html  manifest.json  sw.js
│   └── vercel.json
├── player-extension/       # Chrome/Edge extension (load unpacked / Web Store)
├── GUIDE.md                # command cheat sheet
├── "tinv logo.svg"  "tinv logo.png"
└── .github/workflows/ci.yml
```

> The old Flutter app was removed. Encoding now lives in the Node CLI (large
> files, native SVT-AV1) and the PWA (small files, in-browser).

---

## Convert

### Large files — Node CLI (fast, native SVT-AV1)

```bash
node cli/convert.js input.mp4
node cli/convert.js input.mp4 -o lecture.tinv --preset screencast
node cli/convert.js *.mp4 --preset screencast        # batch
```

Presets: `screencast`, `talkinghead`, `squeeze`, `near`. ffmpeg lives in
`cli/ffmpeg/` (git-ignored — see `cli/ffmpeg/README.md`).

### Small files — in the browser

Open https://tinv.app → **Convert** → pick a video. Encodes locally
(nothing uploaded, nothing to download). Chromium only (Chrome/Edge). Slower than
the CLI and limited by browser memory, so use the CLI for big recordings.

---

## Play

- **Share link:** `https://tinv.app/?url=https://your-host/lecture.tinv`
- **Embed:** `https://tinv.app/embed?url=...`
- **Extension:** install `player-extension/` (Chrome → Developer mode → Load
  unpacked), then click any `.tinv` link to play it inline.

---

## Publish the extension

The extension can ship on the Chrome Web Store:

```bash
cd player-extension && zip -r -q ~/Desktop/tinv-extension.zip . -x "*.DS_Store" && cd ..
```

Upload that ZIP at the [Web Store dev console](https://chrome.google.com/webstore/devconsole)
and fill the listing using `player-extension/STORE_LISTING.md`. You'll also need
a screenshot and the privacy URL (`https://tinv.app/privacy`).

---

## The .tinv format

`"TINV3"` magic + salt + embedded JSON metadata + AES-CTR-encrypted, fragmented
MP4 split on `moof` boundaries — so the player can **stream** it (start playing
before the whole file downloads) via MediaSource. Older `"TINV2"` (single
AES-CTR blob) still decodes. One implementation, shared by the CLI, PWA, and
extension:

- `player-web/tinv-format.js` — `encodeTinv` / `decodeTinv` / `readMetadata` / `isTinv`

A `.tinv` won't play if dragged into a plain browser — that's intentional. This
is obfuscation, not DRM (the secret ships in the players).

---

See [`GUIDE.md`](GUIDE.md) for the full command cheat sheet (setup, convert,
test, deploy, publish).
