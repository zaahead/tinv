# tinv — native converter (Rust)

This directory (`cli/`) is the native Rust CLI; the binary is `tinv` and the
Cargo crate is named `cli`. The original JavaScript converter has been archived
to `cli-old/`.

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

It is **not** faster at encoding — and linking `libsvtav1` directly would **not**
change that. The wall-clock is SVT-AV1's AV1 compression work, which is identical
whether the encoder is driven by the ffmpeg subprocess or called through FFI; the
process overhead we'd remove is milliseconds against multi-second-per-segment
encodes. Going native also wouldn't drop the ffmpeg dependency: `libsvtav1` only
encodes raw YUV, so you'd still need ffmpeg's other libraries to demux, decode,
scale, denoise, and mux. It's a large project whose payoff is a leaner single
binary, **not** speed.

The real speed levers are: a faster SVT preset (6→8 ≈ 2×, 6→10 ≈ 4.4×, for a
small quality cost), distributed encoding across machines (`--workers`), or
hardware AV1 (no encoder exists on Apple Silicon).

## Build

```sh
cd cli
cargo build --release   # -> cli/target/release/tinv (and tinv-worker)
```

## Usage

```sh
cli/target/release/tinv <input...> [options]
```

Options (identical semantics to the archived `cli-old/convert.js`):

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
cd cli && cargo test            # 31 unit tests (crypto, mp4, pool, scheduler, encoder, worker, args, presets)
node --test cli/interop.test.js        # end-to-end: local encode, decode via web module
node --test cli/dist-interop.test.js   # end-to-end: distributed encode + worker-death resilience
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
