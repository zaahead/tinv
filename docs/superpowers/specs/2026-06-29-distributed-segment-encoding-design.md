# Distributed segment encoding for cli — design

**Date:** 2026-06-29
**Status:** Approved, pending implementation plan
**Component:** `cli` (Rust native converter)

## Problem

`cli` and the JS CLI are both bound by SVT-AV1 software encoding. On the target
machine (Apple M3 Max) there is **no hardware AV1 encoder** — only `libsvtav1`/
`libaom-av1` in software (verified via `ffmpeg -encoders`). With AV1 + in-browser
MSE playback as hard constraints, a single machine cannot encode faster without
sacrificing quality (faster SVT preset), fidelity (fps/resolution), or the codec
itself (hardware HEVC, which breaks browser playback).

The one path to a real wall-clock win with **zero quality or codec compromise**
is horizontal: encode independent segments on multiple machines in parallel. The
existing chunked pipeline already produces independent per-segment inputs, so the
distribution seam is shallow.

## Goals

- Distribute the parallel segment-encode step across N worker machines.
- Linear-ish speedup (4 machines ≈ 4× on the encode step) at identical output.
- Output stays wire-compatible TINV3 (plays in web app + extension).
- Resilient: one flaky/dead worker must not fail a long job.
- `--workers` absent ⇒ behavior is byte-for-byte today's local path.

## Non-goals (v1)

- Authentication / TLS (LAN-trusted; documented as a constraint).
- Worker auto-discovery (workers listed statically).
- Linking `libsvtav1` directly / removing the ffmpeg subprocess.
- Distributing split, concat, mux, or TINV3 assembly — those stay local.

## Architecture

A segment encode is referentially transparent: `src_NNNN.mkv` + preset →
`enc_NNNN.mp4`, no shared state, no ordering. That is the unit of distribution.

```
 coordinator (local)                         worker (any box w/ ffmpeg+SVT-AV1)
 ───────────────────                         ──────────────────────────────────
 split → src_0000.mkv ─┐                     GET  /capacity → {cores, svtav1}
        src_0001.mkv ──┼─ scheduler ────────▶ POST /encode  (mkv body + params)
        ...            │  (requeue/retry)    ◀──── 200 enc.mp4 | 4xx fatal | 5xx transient
 collect enc_*.mp4 ◀───┘
 concat + mux → TINV3  (local, unchanged)
```

### Components (all in the `cli` crate)

| Unit | Responsibility | Depends on |
|---|---|---|
| `SegmentEncoder` trait | `encode(src, dst, preset, cap1080) -> Result<()>` | — |
| `LocalEncoder` | today's `run_ffmpeg(segment_encode_args…)` with local `lp` | `ffmpeg.rs` |
| `RemoteEncoder` | HTTP round-trip to one worker; classifies failures | `worker_client` |
| `worker_client` | `GET /capacity`, `POST /encode` over HTTP/1.1 (`ureq`) | — |
| `scheduler` | resilient work queue across executors; requeue/retry/fallback | `SegmentEncoder` |
| `tinv-worker` (bin) | stateless HTTP server; runs segment encode locally | `ffmpeg.rs`, `tiny_http` |

`pipeline::encode_chunked` changes only at the per-segment call site: the
`run_pool(... run_ffmpeg ...)` loop becomes `scheduler::run(tasks, executors)`.
Split, concat, mux, and `tinv::encode_tinv_stream` are untouched.

## Worker protocol (HTTP/1.1, synchronous)

- `GET /capacity` → `200 {"cores":N,"slots":S,"svtav1":true}` where `slots` is
  the number of concurrent encodes the worker accepts (`default_jobs(cores)` on
  the worker's own hardware). Used to size the coordinator's slot count and to
  pre-flight that the worker has a usable encoder.
- `POST /encode?preset=screencast&cap1080=1` with the raw segment `.mkv` as the
  request body. **`lp` is NOT sent** — it depends on the worker's hardware, so
  the worker computes `lp = lp_for(cores, slots)` itself and applies it to every
  encode. Responses:
  - `200` + encoded `.mp4` bytes — success.
  - `4xx` + text message — **fatal** (ffmpeg rejected the input; retrying will
    not help) ⇒ abort the job, surface the message (matches current behavior).
  - `5xx` or transport/connection error/timeout — **transient** ⇒ retry the
    segment on another executor.

The endpoint is stateless and idempotent: the worker writes the body to a temp
file, runs `segment_encode_args` (the same arg vector as local), streams the
result back, and deletes its temp files. No job/session state.

Transport choice: HTTP via `tiny_http` (server) + `ureq` (client) — both small,
synchronous, no async runtime. Rationale: debuggable with `curl`, minimal deps.

## Resilient scheduler

Core idea: **"local" is just another executor.** The scheduler is executor-
agnostic; resilience comes from requeue plus a guaranteed-present local backstop.

- Inputs: a queue of segment indices and a list of `Executor`s. Each remote
  worker contributes `slots` remote executor slots (from `/capacity`); the
  coordinator always contributes `--jobs` local executor slots (using its own
  `lp` as today). Local executors do normal work *and* serve as the backstop —
  with no `--workers`, local slots are the only executors, i.e. today's path.
- Shared state: `Mutex<VecDeque<Task>>` where `Task = { idx, attempts, local_only }`.
- Each executor runs on its own OS thread, pulling tasks:
  - **success** → mark segment done.
  - **transient fail** → mark the worker degraded (short cooldown / skip), push
    the task back with `attempts+1`.
  - **attempts exhausted on remotes** (`> MAX_REMOTE_ATTEMPTS`) → requeue with
    `local_only = true`; only local executors take such tasks, guaranteeing the
    job completes as long as the coordinator works.
  - **fatal (4xx)** → set the shared abort flag and store the error; all
    executors drain and stop.
- Heterogeneous capacity self-balances (faster executors pull more), same
  property as today's `fetch_add` queue.
- Completion: all segments done ⇒ `Ok`; abort flag set ⇒ `Err(stored)`.

`MAX_REMOTE_ATTEMPTS` default: 2 (then fall back to local).

## CLI surface

- New flag: `--workers host:port[,host:port…]`. Absent ⇒ local-only (unchanged).
  `--jobs` continues to size the **local** executor count.
- Header line gains the cluster summary, e.g.
  `… jobs=4, lp=4, workers=2 (16 remote + 4 local slots) …`. Workers that fail
  the `/capacity` pre-flight are dropped with a warning.
- Per-segment progress reporting is unchanged (counts completions regardless of
  which executor finished them).

## Error handling summary

| Condition | Classification | Action |
|---|---|---|
| `200` | success | accept encoded bytes |
| `4xx` from worker | fatal | abort job, surface message |
| `5xx` / connect / timeout | transient | cooldown worker, requeue (attempts+1) |
| remote attempts exhausted | — | requeue `local_only`, encode on coordinator |
| all remotes degraded | — | local executors carry the whole job |
| coordinator ffmpeg (split/concat/mux) fails | fatal | abort (as today) |

## Testing

- **Unit (no network):** `scheduler` with fake executors (closures returning
  success / transient / fatal): proves requeue-on-transient, abort-on-fatal,
  completion via local fallback when a remote always fails, and that every
  segment is encoded exactly once on success.
- **Worker unit:** request parsing (params → arg vector), capacity JSON.
- **Integration (loopback):** spawn a real `tinv-worker` on `127.0.0.1:<port>`,
  run the coordinator with `--workers 127.0.0.1:<port>` against a generated
  clip, decode the result through `web/tinv-format.js`, assert valid fMP4
  (extends `cli/cli-interop.test.js`).
- **Resilience integration:** two loopback workers; kill one mid-run; assert the
  job still completes and decodes.

## Prerequisites & constraints

- Each worker box needs the bundled ffmpeg+SVT-AV1 present (same as coordinator).
- LAN-trusted: no auth/TLS in v1. The worker runs ffmpeg on uploaded bytes — do
  not expose it to untrusted networks. Documented in the worker README.
- Segment transfer is inline in HTTP bodies (~10 MB up, ~0.3 MB down per
  segment); over LAN this is negligible against a multi-second encode. No shared
  filesystem or object store.

## Expected outcome

On the encode step, wall-clock scales ~linearly with total worker capacity at
identical TINV3 output. A 40-min screencast that takes ~8 min on one M3 Max
finishes in ~2 min across four comparable machines, with no quality, codec, or
playback-compatibility change.
