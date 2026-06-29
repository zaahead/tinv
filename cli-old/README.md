# tinv local converter

Independent, parallel encoder. Produces `.tinv` (AV1-in-fMP4, TINV3) that the web
app and extension can play.

## Usage

    node cli/convert.js <input...> [options]

Options:
- `--preset screencast|talkinghead|squeeze|near` (default: screencast)
- `--jobs N` — max concurrent encodes (default: min(4, logical CPUs)). Each
  encode's SVT-AV1 thread count (`lp`) is set to ≈ cores / jobs, so total
  encoder threads track the core count at any `--jobs` value instead of every
  encode grabbing all cores (which oversubscribes and thrashes).
- `--segment SEC` — target segment length when chunking (default: 30)
- `--min-split SEC` — only split files at least this long (default: 60)
- `--no-cap` — do not cap height to 1080
- `-o, --out FILE` — output path (single input only)

Small files encode whole; large files are copy-split at keyframes, encoded in
parallel, concat-copied, muxed with a single Opus track, and fragmented.
The lightweight copy/split/concat and the single audio-encode passes run outside
the `--jobs` cap, so a chunking file may briefly run slightly more than `--jobs`
ffmpeg processes (all but the segment encodes are `-c copy` or a light Opus pass,
so the impact is negligible).

## Tuning for your machine

`--jobs` and the SVT-AV1 `svt` preset (in `cli/ffmpeg.js` `PRESETS`) are the speed
levers. To pick defaults, benchmark a representative big file:

    for j in 4 8 12 16; do
      echo "jobs=$j"; time node cli/convert.js cli/r.mp4 --jobs $j -o /tmp/r_$j.tinv
    done

Higher `svt` (6 → 10) trades a few percent size for more speed. Hardware AV1
(`av1_videotoolbox`) is intentionally not used: the bundled ffmpeg lacks it, and
hardware HEVC would break Chrome/Firefox playback.
