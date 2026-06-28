# tinv Local Parallel Encoder — Design

Date: 2026-06-28
Status: Approved (design), pending implementation plan

## Goal

The local CLI converter (`cli/`) is a **fully independent pipeline** from the web
converter. Its job is to saturate the full power of the local machine (M3 Max,
16 cores: 12 performance + 4 efficiency) when encoding video to `.tinv`.

The web converter is unchanged. The extension and web app remain players.
The three share **output**, not code: a `.tinv` file produced by the CLI must
play in the web app and the extension. Codec/container stay AV1-in-fragmented-MP4
inside the TINV3 container; parallelism is purely an encode-time speedup.

## Key technical constraint

A single SVT-AV1 encode does not scale past ~6–8 threads. To use 12–16 cores you
need **chunked parallel encoding**: split the video, run many encoder workers
concurrently, then stitch the results. This is the core of the design.

## Workload

Both workloads matter equally:

- **Many files at once** — a batch of clips.
- **One huge file at a time** — e.g. `cli/shan.mp4` (~9 GB), `cli/r.mp4` (~808 MB).

A single **work pool** with N slots serves both: a small file is one whole-file
job; a big file is split into K segment jobs plus one audio job. Both feed the
same pool, so cores stay saturated in the mixed case automatically.

## Engine choice

In-house Node orchestrator (no Av1an / external chunked-encoder dependency). Node
spawns N parallel `ffmpeg` + SVT-AV1 workers, splits/concats segments itself, then
fragments to fMP4 and wraps `.tinv`. Keeps the CLI self-contained (it already
bundles ffmpeg) and gives full control over the tinv-specific fMP4 output.

## Architecture & file layout

The CLI becomes a small set of focused, independently testable modules instead of
one script.

| File | Responsibility |
|------|----------------|
| `cli/convert.js` | Entry: parse args, discover inputs, report progress, schedule files into the pool. |
| `cli/pool.js` | Generic concurrency-limited task runner (`run(tasks, limit)`). Pure — no ffmpeg knowledge. Independently testable. |
| `cli/ffmpeg.js` | Locate ffmpeg/ffprobe, probe (duration / has-audio), build encode arg arrays. Extracted from today's `convert.js`. |
| `cli/pipeline.js` | `convertOne(src, dst, preset, opts)`: decide whole-file vs chunked, orchestrate stages, wrap `.tinv`. |
| `cli/tinv-format.js` | Already built — encoder-only, wire-compatible with `web/tinv-format.js`. Unchanged by this work. |

Each unit answers: what it does, how it's used, what it depends on. `pool.js` is
pure logic; `ffmpeg.js` is the only module that knows ffmpeg arg syntax.

## Concurrency & scheduling policy

- One global semaphore of **N slots**, controlled by `--jobs`. Default chosen by
  benchmarking `r.mp4` / `shan.mp4`; starting point ≈ core count, with each
  SVT-AV1 worker thread-capped (e.g. via SVT `lp`) so N workers do not
  oversubscribe the 16 cores. Total concurrent encoder threads ≈ cores.
- **Unified queue.** Small file → one whole-file encode job. Big file → K segment
  jobs + 1 audio job. A batch of small files and one giant file share the same N
  slots.
- **Split decision.** Two distinct knobs:
  - `--segment` = target segment length in seconds (default ~30 s). When a file
    is chunked, it is cut into segments of roughly this length.
  - `--min-split` = minimum file duration (seconds) worth splitting at all
    (default ~2× the segment length). A file shorter than this is encoded as a
    single whole-file job — splitting tiny files is pure overhead.
- Tunable: `--jobs`, `--segment`, `--min-split`.

## Chunked single-file pipeline (the core new path)

DAG that guarantees gap/overlap-free output:

1. **Fast copy-split** the source video stream at its own keyframes via ffmpeg's
   segment muxer (`-c copy`, single fast IO-bound pass) → contiguous source
   segments.
2. **Parallel encode** each source segment → AV1 (`-an`, video-only), filling pool
   slots. Same SVT-AV1 preset params and ~2 s GOP as today so fragments stay
   streamable.
3. **Concat-copy** the AV1 segments (concat demuxer, `-c copy`) → full AV1 video,
   no re-encode.
4. **Encode audio once** — single Opus pass (mono) over the original source.
   Encoding audio per-segment then concatenating risks Opus priming/gap artifacts;
   one pass avoids them.
5. **Final mux** video + audio with `-movflags +frag_keyframe+empty_moov+default_base_moof`
   and `-frag_duration` → streaming fragmented MP4.
6. **Wrap** the fMP4 via `encodeTinvStream` (from `cli/tinv-format.js`) → `.tinv`.

Whole-file path (small files / below threshold) is today's single-ffmpeg flow,
just running inside a pool slot.

### Per-file resource & failure handling

- One temp dir per file (under `os.tmpdir()`), cleaned on success and on failure.
- If any segment job fails, that file fails (cleaned up) and is reported; the rest
  of the batch continues.
- Progress: aggregate percent across a file's segments (sum of encoded duration /
  total duration).

## Interop & output

Output is unchanged on the wire: AV1-in-fMP4 inside the TINV3 container. The
extension and web app play every CLI-made file. Chunking is invisible to players.

## Testing

- **Unit — `pool.js`:** honors the concurrency limit; propagates a worker error.
- **Unit — segment math:** segment time-range computation for a given duration /
  segment length.
- **Integration — interop:** encode the small generated test clip **both**
  whole-file and force-chunked (e.g. `--segment 0.5` on a 2 s clip), decode each
  with the *web* module (`web/tinv-format.js`), assert a valid `ftyp` fMP4 payload
  and correct duration. Proves the chunked path stays interop-correct.
- **Benchmark (manual, not CI):** time `r.mp4` / `shan.mp4` across `--jobs` values
  to set the defaults.

## Known tradeoff

Copy-splitting at **source** keyframes (step 1) means segment sizes follow the
source's keyframe spacing. For typical screen/camera footage that's fine; a source
with very sparse keyframes yields fewer, larger segments and less parallelism. The
alternative — frame-accurate re-decode splitting — is more complex and slower to
split. Decision: use copy-split for robustness; revisit only if a real file is seen
to underutilize cores.

## Out of scope

- Changing the web converter or the players.
- Hardware AV1 (`av1_videotoolbox`): the bundled ffmpeg 8.1 lacks the encoder, and
  HEVC hardware would break Chrome/Firefox playback. Not pursued here.
- Any change to the TINV3 wire format.
