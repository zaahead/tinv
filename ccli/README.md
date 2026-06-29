# ccli — native tinv converter (Rust)

A single-binary Rust port of the local encoder. It drives the same bundled
`ffmpeg`+SVT-AV1 for the encode, but does orchestration, parallel scheduling,
and the **TINV3 container natively**. Output is wire-compatible with the JS
encoder, so `.tinv` files made here play in the web app and the extension.

The binary is named `tinv`.

## Why it exists / what it does (and doesn't) buy you

The encode is bound by SVT-AV1, which is native C either way — so wall-clock is
**roughly equal to the tuned JS CLI**, not faster. What the Rust version buys:

- a **single static binary**, no Node runtime dependency;
- **true OS-thread** orchestration with bounded, abort-on-error scheduling;
- native TINV3 container writing (AES-256-CTR, SHA-256 key) with no JS crypto.

It is **not** faster at encoding. To genuinely beat the current speed you'd have
to link `libsvtav1` directly and drop the ffmpeg subprocess (a much larger
project). See the design discussion in the repo history.

## Build

```sh
cd ccli
cargo build --release   # -> ccli/target/release/tinv
```

## Usage

```sh
ccli/target/release/tinv <input...> [options]
```

Options (identical semantics to `cli/convert.js`):

- `--preset screencast|talkinghead|squeeze|near` (default: screencast)
- `--jobs N` — max concurrent encodes (default: `min(4, logical CPUs)`). Each
  encode's SVT-AV1 thread count is set to `lp = floor(cores / jobs)`, so total
  encoder threads track the core count at any `--jobs` value instead of every
  encode grabbing all cores (which oversubscribes and thrashes).
- `--segment SEC` — target segment length when chunking (default: 30)
- `--min-split SEC` — only split files at least this long (default: 60)
- `--no-cap` — do not cap height to 1080
- `-o, --out FILE` — output path (single input only)

Small files encode whole; large files are copy-split at keyframes, encoded in
parallel, concat-copied, muxed with a single Opus track, fragmented, then wrapped
in TINV3.

## ffmpeg resolution

Looks for the encoder in this order: `TINV_FFMPEG` / `TINV_FFPROBE` env vars,
then `cli/ffmpeg/<bin>` (relative to cwd or the executable), then `PATH`. The
bundled binary must include `libsvtav1`.

## Tests

```sh
cd ccli && cargo test          # 31 unit tests (crypto, mp4, pool, scheduler, encoder, worker, args, presets)
node --test cli/ccli-interop.test.js        # end-to-end: local encode, decode via web module
node --test cli/ccli-dist-interop.test.js   # end-to-end: distributed encode + worker-death resilience
```

The interop tests are the wire-compatibility guarantee: they run the built
binaries and decode the result with `web/tinv-format.js`, asserting valid
fragmented MP4 — for both the local and distributed (multi-worker) paths.

## Distributed encoding (multi-machine)

The encode is the bottleneck and segments are independent, so they can be
farmed out to worker machines for near-linear speedup at identical output.

On each worker (needs the bundled ffmpeg+SVT-AV1, or `TINV_FFMPEG` set):

```sh
tinv-worker 0.0.0.0:7878
```

On the coordinator:

```sh
tinv big.mp4 --workers 10.0.0.5:7878,10.0.0.6:7878
```

The coordinator pre-flights each worker's `/capacity`, sizes remote slots from
the worker's own core count, and schedules segments across remote slots plus
local backstop slots (`--jobs`). A worker that fails or dies mid-run has its
segments retried elsewhere and ultimately encoded locally, so a single flaky
worker never fails the job.

**Security:** no auth/TLS in v1 — run workers on a trusted LAN only. A worker
runs ffmpeg on whatever bytes it is sent; do not expose it to the open internet.
