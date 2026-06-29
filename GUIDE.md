# tinv converter — install & use guide

`tinv` is the native command-line converter: it turns any video into a tiny
`.tinv` file (AV1 + Opus in an obfuscated container) that plays in the tinv web
player and browser extension. It wraps **ffmpeg + SVT-AV1** for the encode and
can optionally fan work out across several machines.

This guide takes you from nothing to `tinv convert video.mp4`.

---

## Install

### 1. Prerequisites

You need two things: a **Rust toolchain** (to build `tinv`) and **ffmpeg**
built with `libsvtav1` (the AV1 encoder) and `libopus`.

**macOS (Homebrew):**

```bash
brew install rust ffmpeg
```

Homebrew's `ffmpeg` already includes `svt-av1` and `opus`, so it works out of
the box.

**Linux (Debian/Ubuntu):**

```bash
sudo apt update && sudo apt install -y cargo ffmpeg
```

On older distros the packaged `ffmpeg` may lack `libsvtav1` — check with the
verify command below; if it's missing, install a newer ffmpeg or a static build
with `--enable-libsvtav1 --enable-libopus`.

Confirm your ffmpeg has the encoders (you should see **two** lines):

```bash
ffmpeg -hide_banner -encoders | grep -E "libsvtav1|libopus"
```

### 2. Build & install

```bash
git clone https://github.com/zaahead/tinv.git
cd tinv/cli
cargo install --path .
```

This builds and installs two binaries into `~/.cargo/bin`:

- **`tinv`** — the converter (and distributed coordinator)
- **`tinv-worker`** — the optional encode worker for multi-machine jobs

### 3. Put it on your PATH

If `tinv` isn't found after installing, add `~/.cargo/bin` to your PATH:

```bash
# zsh (macOS default)
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

### 4. Verify

```bash
tinv            # prints the usage line
```

You're done. Convert something:

```bash
tinv convert video.mp4     # → video.tinv next to the input
```

---

## Use

### Convert

```bash
# Simplest — writes lecture.tinv next to the input
tinv convert lecture.mp4
tinv lecture.mp4                 # the `convert` verb is optional

# Pick a preset
tinv lecture.mp4 --preset talkinghead

# Choose the output path (single input only)
tinv lecture.mp4 -o ~/out/lecture.tinv --preset screencast

# Keep the source resolution (don't cap to 1080p)
tinv gameplay.mp4 --no-cap --preset near

# Batch — every match becomes <name>.tinv beside it
tinv *.mp4 --preset screencast
tinv a.mp4 b.mov c.mkv
```

### Flags

| Flag | Default | What it does |
|------|---------|--------------|
| `--preset <name>` | `screencast` | Encoding recipe (see table below). |
| `--no-cap` | 1080p cap **on** | Don't downscale to 1080p height; keep source resolution. |
| `--jobs N` | `min(4, cores)` | Max concurrent segment encodes. Each gets ≈ `cores/jobs` SVT-AV1 threads, so the machine stays saturated without thrashing. |
| `--segment SEC` | `30` | Target chunk length when a long file is split for parallel encoding. |
| `--min-split SEC` | `60` | Only split files at least this long; shorter files encode whole. |
| `--workers host:port,…` | none | Distribute segment encoding across worker machines (see below). |
| `-o`, `--out <file>` | `<input>.tinv` beside source | Output path. **Ignored for batches** — only used with exactly one input. |

A leading `convert` is accepted but optional. Everything else positional is an
input file; globs are expanded by your shell.

### Presets

| Preset | fps | CRF | SVT preset | Denoise | Audio | Use for |
|--------|----:|----:|-----------:|:-------:|------:|---------|
| `screencast` *(default)* | 15 | 34 | 6 | yes | 20 kbps | Screen recordings, slides, terminals |
| `talkinghead` | 24 | 30 | 6 | yes | 24 kbps | Webcam / presenter footage |
| `squeeze` | 10 | 38 | 2 | yes | 16 kbps | Maximum compression, smallest file |
| `near` | 24 | 26 | 4 | no | 32 kbps | Near-transparent quality |

Lower CRF = higher quality + bigger file. Lower SVT preset = slower encode +
better compression. Audio is always downmixed to **mono**.

### What you get

```
→ lecture.mp4  (Screencast)
  ✓ 142.0 MB → 6.3 MB  (22.5× smaller)  lecture.tinv
```

- AV1 video + Opus audio in a fragmented MP4, wrapped in the obfuscated `.tinv`
  container with embedded metadata (title from the filename, source + encoded
  sizes).
- ~2s keyframe interval so the players can **stream** (start before the full
  file downloads).
- Play it at `https://tinv.app/?url=<hosted .tinv URL>`.

---

## Distributed encoding (multi-machine)

The encode is bound by SVT-AV1, so the way to go genuinely faster (without
trading quality) is to spread independent segments across machines.

**On each worker** (needs ffmpeg with libsvtav1; install `tinv` there too):

```bash
tinv-worker 0.0.0.0:7878
```

**On your machine (the coordinator):**

```bash
tinv big.mp4 --workers 10.0.0.5:7878,10.0.0.6:7878
```

The coordinator splits the video, farms segments to the workers (sized to each
worker's core count) plus its own local cores, then assembles the result. A
worker that fails or dies mid-job has its segments retried elsewhere and, if
needed, finished locally — so a flaky worker never fails the job.

**Security:** there's no auth or TLS — run workers on a **trusted LAN only**. A
worker runs ffmpeg on whatever bytes it's sent; never expose it to the internet.

---

## How ffmpeg is found

`tinv` looks for `ffmpeg`/`ffprobe` in this order:

1. `TINV_FFMPEG` / `TINV_FFPROBE` environment variables (explicit paths)
2. an `ffmpeg/` folder next to the `tinv` binary (e.g. `~/.cargo/bin/ffmpeg/`)
3. `cli/ffmpeg/` when you run it from inside the repo
4. `ffmpeg` on your `PATH`

The binary must include **libsvtav1** and **libopus**.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `command not found: tinv` | `~/.cargo/bin` isn't on your PATH — see Install step 3, then open a new terminal. |
| `ffmpeg with libsvtav1 not found` | Install an ffmpeg that has it (`brew install ffmpeg`), or point at one: `export TINV_FFMPEG=/path/to/ffmpeg TINV_FFPROBE=/path/to/ffprobe`. |
| Verify fails (no `libsvtav1` line) | Your ffmpeg lacks the AV1 encoder; install a newer/static build. |
| Encode feels slow | Expected — it's SVT-AV1 doing real AV1 compression. Use a faster `--preset` (6→8 ≈ 2×) or `--workers`. |
| Updated the code | Reinstall: `cargo install --path cli --force`. |
| Remove it | `cargo uninstall cli` (removes both `tinv` and `tinv-worker`). |

### Exit codes

| Situation | Behaviour |
|-----------|-----------|
| No input given | Prints usage, exits `1`. |
| Unknown `--preset` | Prints valid options, exits `1`. |
| No ffmpeg with libsvtav1 | Prints install hint, exits `1`. |
| One file in a batch fails | Logs `✗ name: reason`, continues, exits `1` at the end. |
| All succeed | Exits `0`. |

---

See [`README.md`](README.md) for the project overview and how `.tinv` files
play, host, and share, and [`cli/README.md`](cli/README.md) for the converter's
internals.
