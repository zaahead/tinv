# tinv — commands cheat sheet

Run from the project root:

```bash
cd "/Users/zaahead/Downloads/tinv files/tinv"
```

---

## First-time setup

```bash
# 1. Node 18+ required (uses global crypto.subtle + top-level await). Check:
node --version

# 2. The CLI needs a static ffmpeg with SVT-AV1 + Opus in cli/ffmpeg/:
#      cli/ffmpeg/ffmpeg
#      cli/ffmpeg/ffprobe
#    (git-ignored — see cli/ffmpeg/README.md). Verify a binary:
./cli/ffmpeg/ffmpeg -hide_banner -encoders | grep -E "libsvtav1|libopus"

# 3. For deploying the PWA, log in to Vercel once:
vercel login
```

No `npm install` needed — the CLI uses only Node built-ins. (The PWA encodes
in-browser with native WebCodecs AV1 — nothing to download or install.)

---

## Convert — Node CLI (the fast path, native SVT-AV1)

```bash
# Single file → lecture.tinv next to the source
node cli/convert.js lecture.mp4

# Choose output + preset
node cli/convert.js lecture.mp4 -o out.tinv --preset screencast

# Batch (one .tinv per input, next to each)
node cli/convert.js *.mp4 --preset screencast

# Keep original resolution (default caps to 1080p)
node cli/convert.js lecture.mp4 --no-cap

# Show usage
node cli/convert.js
```

**Flags:** `--preset <name>` · `-o`/`--out <file>` (single input only) · `--no-cap`

**Presets:**

| Name | fps | CRF | SVT effort | Use |
|------|-----|-----|-----------|-----|
| `screencast` (default) | 15 | 34 | 4 | Slides / screen recordings |
| `talkinghead` | 24 | 30 | 4 | Person on camera |
| `squeeze` | 10 | 38 | 2 | Smallest file (slowest encode) |
| `near` | 24 | 26 | 4 | Higher quality |

Output is a protected `.tinv` (won't play in a plain browser). ffmpeg is found
in `cli/ffmpeg/` first, then `tools/ffmpeg/`, then PATH.

---

## Convert — in the browser (PWA)

For short / small videos when you don't want the CLI. Encodes locally with
native WebCodecs — nothing is uploaded, nothing to download. **Chromium only**
(Chrome/Edge); other browsers see an "unsupported" notice and should use the CLI.

1. Open **https://tinv.app** (or `http://localhost:8777` locally) in Chrome/Edge.
2. Click **Convert** (top right).
3. **Choose video…**, pick a preset, optionally toggle **Cap at 1080p**.
4. Click **Convert** — encodes on-device via WebCodecs.
5. **Download** the resulting `.tinv`.

> Browser encoding loads the whole file into memory and is slower than the
> native CLI. For big recordings use the Node CLI.

---

## Test / validate

```bash
# Syntax-check all JS
for f in player-web/*.js player-extension/*.js cli/convert.js; do node --check "$f"; done

# .tinv format round-trip (encode → decode must match) — same as CI
node --input-type=module -e '
  import { encodeTinv, decodeTinv, isTinv } from "./player-web/tinv-format.js";
  const w = new Uint8Array(Array.from({length:1000},(_,i)=>(i*7+13)%256));
  const t = await encodeTinv(w, {title:"X"});
  const {blob} = await decodeTinv(t);
  const b = new Uint8Array(await blob.arrayBuffer());
  console.log(isTinv(t) && b.every((x,i)=>x===w[i]) ? "OK" : "FAIL");
'

# Confirm a file is the protected format (starts with "TINV3")
xxd yourfile.tinv | head -1        # should begin: 5449 4e56 33  (TINV3)
                                   #     or legacy: 5449 4e56 32  (TINV2)

# Decode a .tinv back to a playable .mp4 (for inspection; TINV3 payload is fMP4)
node --input-type=module -e '
  import { readFile, writeFile } from "node:fs/promises";
  import { decodeTinv } from "./player-web/tinv-format.js";
  const t = new Uint8Array(await readFile(process.argv[1]));
  const { blob } = await decodeTinv(t);
  await writeFile("decoded.mp4", new Uint8Array(await blob.arrayBuffer()));
  console.log("wrote decoded.mp4");
' yourfile.tinv
```

CI (`.github/workflows/ci.yml`) runs the JS syntax check + the format
round-trip on every push.

---

## PWA (player-web/)

```bash
# Serve locally
cd player-web && python3 -m http.server 8777    # http://localhost:8777
cd ..

# Deploy to production (Vercel)
cd player-web && vercel deploy --prod --yes && cd ..

# (Re)point the domain to the latest deployment if needed
vercel alias set <deployment-url> tinv.app
```

- **Live:** https://tinv.app
- **Share:** `https://tinv.app/?url=https://your-host/lecture.tinv`
- **Embed:** `https://tinv.app/embed?url=...`
- **Privacy:** https://tinv.app/privacy (served from `privacy.html`)

---

## Extension (player-extension/)

### Develop (load unpacked)
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `player-extension/`
3. After edits: click **🔄 reload**, then **close + reopen** any player tab

```bash
# Keep shared code in sync after editing player-web/
cp player-web/player-core.js  player-extension/player-core.js
cp player-web/tinv-format.js  player-extension/tinv-format.js
```

### Publish to the Chrome Web Store
```bash
# Package a clean submission ZIP
cd player-extension && rm -f ~/Desktop/tinv-extension.zip && \
  zip -r -q ~/Desktop/tinv-extension.zip . -x "*.DS_Store" -x "__MACOSX*" && cd ..
```

Then at https://chrome.google.com/webstore/devconsole — upload the ZIP and fill
the listing using `player-extension/STORE_LISTING.md`. You still need:
- A **screenshot** (1280×800 or 640×400) of the player on a `.tinv`
- The **privacy policy URL**: `https://tinv.app/privacy`
- A **permission justification** for `<all_urls>` (text is in STORE_LISTING.md)

---

## ffmpeg (bundled with the CLI)

```bash
# Verify the bundled binary has the right encoders + is self-contained
./cli/ffmpeg/ffmpeg -hide_banner -encoders | grep -E "libsvtav1|libopus"
otool -L ./cli/ffmpeg/ffmpeg | grep -v "/System\|/usr/lib"   # macOS — should be empty

# The exact encode the CLI runs (screencast preset) — handy for debugging.
# Output is a fragmented MP4 (moof per ~2s keyframe) so the .tinv can stream.
./cli/ffmpeg/ffmpeg -y -i input.mp4 \
  -c:v libsvtav1 -crf 34 -preset 4 -g 30 -svtav1-params tune=0 \
  -vf "fps=15,scale=-2:'min(1080,ih)',hqdn3d=2:1:2:3" \
  -c:a libopus -b:a 20k -ac 1 \
  -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 \
  -f mp4 out.mp4
```

If `cli/ffmpeg/` is missing, the CLI falls back to ffmpeg on PATH (must have SVT-AV1).

---

## The .tinv format

`"TINV3"` magic + 16-byte salt + embedded JSON metadata (incl. a segment table)
+ AES-CTR-encrypted, fragmented MP4 split on `moof` boundaries. The player feeds
the fragments to MediaSource as they download, so a remote `.tinv` **streams**
(starts before the full download). Legacy `"TINV2"` (single AES-CTR WebM blob)
still decodes. One implementation: `player-web/tinv-format.js` (used by CLI, PWA,
extension). fMP4 is used over WebM because browser MediaSource reliably accepts
AV1-in-MP4 but not AV1 in WebM clusters.

- `encodeTinv(webmBytes, meta)` → `Uint8Array` (the `.tinv`)
- `decodeTinv(tinvBytes)` → `{ blob, meta }`
- `readMetadata(tinvBytes)` → `meta` (no video decode)
- `isTinv(bytes)` → boolean

A `.tinv` won't play if dragged into a plain browser — intentional. This is
obfuscation, not DRM (the secret ships in the players). Changing the secret in
`tinv-format.js` breaks all previously-encoded files.

---

## Gotchas

| Symptom | Fix |
|---|---|
| Extension shows old UI | Reload in `chrome://extensions` **and** close/reopen the player tab |
| `.tinv` plays when dragged into a browser | It's a *legacy* plain-WebM file — re-convert with the current CLI |
| PWA Convert fails on a big file | Browser ran out of memory — use the Node CLI instead |
| PWA Convert shows "unsupported" | Not a Chromium browser (needs WebCodecs AV1) — use Chrome/Edge or the CLI |
| CLI says "libsvtav1 not found" | `cli/ffmpeg/` missing; restore it or put a static ffmpeg on PATH |
| Vercel deploy 401 / login page | Deployment Protection is on — disable it in the project's dashboard settings |
