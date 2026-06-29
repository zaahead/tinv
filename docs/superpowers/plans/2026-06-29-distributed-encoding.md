# ccli Distributed Segment Encoding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribute the parallel segment-encode step of `ccli` across worker machines over HTTP, with retry/requeue resilience and a guaranteed local fallback, keeping output wire-compatible TINV3.

**Architecture:** A segment encode (`src.mkv` + preset → `enc.mp4`) is referentially transparent, so it can run on any machine. A `SegmentEncoder` trait abstracts local-ffmpeg vs remote-HTTP execution. A resilient scheduler runs segments across executors (remote worker slots + local backstop slots), requeueing transient failures and falling back to local. A second binary `tinv-worker` is a stateless HTTP server that runs the same `segment_encode_args` locally. Split, concat, mux, and TINV3 assembly stay on the coordinator, unchanged.

**Tech Stack:** Rust 2021; `ureq` 2 (sync HTTP client), `tiny_http` 0.12 (sync HTTP server); existing `aes`/`ctr`/`sha2`; bundled `ffmpeg`+SVT-AV1.

## Global Constraints

- Rust edition 2021; dependencies pinned: `sha2 = "0.10"`, `aes = "0.8"`, `ctr = "0.9"`, `ureq = "2"`, `tiny_http = "0.12"`. Synchronous only — no tokio/async runtime.
- TINV3 container is **wire-compatible** and unchanged; output must decode via `web/tinv-format.js`.
- With no `--workers`, behavior is the current local-only path (local executors are the only executors).
- `lp` is computed by each executor's host from its own cores; the coordinator never sends `lp` to a worker. `POST /encode` params are `preset` and `cap1080` only.
- Failure classification: HTTP `4xx` = **Fatal** (abort job); HTTP `5xx`/transport/timeout = **Transient** (requeue). `MAX_REMOTE_ATTEMPTS = 2`, then requeue `local_only`.
- No auth/TLS in v1; LAN-trusted. Each worker box requires the bundled `ffmpeg`+`libsvtav1`.
- TDD, frequent commits. Run `cargo test` from `ccli/`. Work happens on branch `feature/ccli-distributed-encoding`.

## File Structure

- `ccli/Cargo.toml` — add `[lib]`, deps, `[[bin]] tinv-worker`.
- `ccli/src/lib.rs` (new) — declare all modules `pub`.
- `ccli/src/main.rs` (modify) — `use ccli::…`; add `--workers`; build executors.
- `ccli/src/encoder.rs` (new) — `SegmentEncoder` trait, `EncodeErr`, `LocalEncoder`, `RemoteEncoder`.
- `ccli/src/worker_client.rs` (new) — `capacity()`, `encode()`, pure parsers.
- `ccli/src/scheduler.rs` (new) — resilient executor scheduler.
- `ccli/src/worker.rs` (new) — worker request handling (pure param parsing + handler helpers).
- `ccli/src/bin/tinv-worker.rs` (new) — worker server entry point.
- `ccli/src/pipeline.rs` (modify) — `encode_chunked` uses the scheduler + executors.
- `cli/ccli-dist-interop.test.js` (new) — loopback integration + resilience tests.

---

### Task 1: Restructure into a library + add dependencies

**Files:**
- Create: `ccli/src/lib.rs`
- Modify: `ccli/src/main.rs:11-17` (module declarations → imports)
- Modify: `ccli/Cargo.toml`

**Interfaces:**
- Produces: crate library `ccli` exposing `pub mod {preset, ffmpeg, pool, mp4, tinv}` (and, in later tasks, `encoder, worker_client, scheduler, worker`).

- [ ] **Step 1: Add deps and lib/bin config to `ccli/Cargo.toml`**

Replace the `[dependencies]` section and add `[lib]` + the worker bin:

```toml
[lib]
name = "ccli"
path = "src/lib.rs"

[[bin]]
name = "tinv"
path = "src/main.rs"

[[bin]]
name = "tinv-worker"
path = "src/bin/tinv-worker.rs"

[dependencies]
sha2 = "0.10"
aes = "0.8"
ctr = "0.9"
ureq = "2"
tiny_http = "0.12"
```

- [ ] **Step 2: Create `ccli/src/lib.rs`**

```rust
//! tinv native converter — shared library used by the `tinv` coordinator and
//! the `tinv-worker` binaries.
pub mod ffmpeg;
pub mod mp4;
pub mod pool;
pub mod preset;
pub mod tinv;
```

- [ ] **Step 3: Update `ccli/src/main.rs` to use the library**

Replace the module declaration block:

```rust
mod ffmpeg;
mod mp4;
mod pipeline;
mod pool;
mod preset;
mod tinv;

use std::io::IsTerminal;
use std::path::Path;

use pipeline::{convert_one, Opts, Progress};
```

with (note `pipeline` stays a `main`-local module for now; library modules come from the crate):

```rust
mod pipeline;

use std::io::IsTerminal;
use std::path::Path;

use ccli::{ffmpeg, pool, preset};
use pipeline::{convert_one, Opts, Progress};
```

- [ ] **Step 4: Make `pipeline.rs` use library modules**

In `ccli/src/pipeline.rs`, change the `use crate::…` imports to `use ccli::…`:

```rust
use ccli::ffmpeg;
use ccli::pool;
use ccli::preset::Preset;
use ccli::tinv::{self, Meta};
```

(`main.rs` declares `mod pipeline;`, so `pipeline` is part of the `tinv` bin crate and refers to the library as `ccli::…`.)

- [ ] **Step 5: Build and test**

Run: `cd ccli && cargo test`
Expected: all 18 existing tests PASS; both bins are unknown yet only `tinv` builds (the `tinv-worker` path doesn't exist — see note).

NOTE: `[[bin]] tinv-worker` references a not-yet-created file. To keep this task green, create a stub now:

- [ ] **Step 6: Stub `ccli/src/bin/tinv-worker.rs`**

```rust
fn main() {
    eprintln!("tinv-worker: not yet implemented");
    std::process::exit(1);
}
```

Run: `cd ccli && cargo build && cargo test`
Expected: builds clean; 18 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add ccli/Cargo.toml ccli/Cargo.lock ccli/src/lib.rs ccli/src/main.rs ccli/src/pipeline.rs ccli/src/bin/tinv-worker.rs
git commit -m "refactor(ccli): split into library + bins, add http deps"
```

---

### Task 2: SegmentEncoder trait + LocalEncoder

**Files:**
- Create: `ccli/src/encoder.rs`
- Modify: `ccli/src/lib.rs` (add `pub mod encoder;`)

**Interfaces:**
- Produces:
  - `enum EncodeErr { Transient(String), Fatal(String) }`
  - `trait SegmentEncoder: Send + Sync { fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr>; }`
  - `struct LocalEncoder { pub ffmpeg: String, pub lp: usize }` implementing `SegmentEncoder`.

- [ ] **Step 1: Write the failing test in `ccli/src/encoder.rs`**

```rust
// SegmentEncoder abstracts where a single segment is encoded (local ffmpeg or a
// remote worker). EncodeErr separates retryable failures from fatal ones.
use std::path::Path;

use crate::ffmpeg;
use crate::preset::Preset;

#[derive(Debug)]
pub enum EncodeErr {
    Transient(String),
    Fatal(String),
}

pub trait SegmentEncoder: Send + Sync {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr>;
}

pub struct LocalEncoder {
    pub ffmpeg: String,
    pub lp: usize,
}

impl SegmentEncoder for LocalEncoder {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr> {
        use std::sync::atomic::AtomicBool;
        let abort = AtomicBool::new(false);
        let args = ffmpeg::segment_encode_args(
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
            p,
            cap1080,
            self.lp,
        );
        ffmpeg::run_ffmpeg(&self.ffmpeg, &args, &abort).map_err(EncodeErr::Fatal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::preset;

    #[test]
    fn local_encoder_maps_ffmpeg_failure_to_fatal() {
        // A bogus ffmpeg binary makes run_ffmpeg fail; LocalEncoder must surface
        // that as Fatal (today's behavior: local errors abort the job).
        let enc = LocalEncoder { ffmpeg: "/nonexistent/ffmpeg".into(), lp: 1 };
        let r = enc.encode(
            Path::new("/tmp/in.mkv"),
            Path::new("/tmp/out.mp4"),
            preset("screencast").unwrap(),
            true,
        );
        assert!(matches!(r, Err(EncodeErr::Fatal(_))));
    }
}
```

- [ ] **Step 2: Register the module — add to `ccli/src/lib.rs`**

```rust
pub mod encoder;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd ccli && cargo test encoder::`
Expected: `local_encoder_maps_ffmpeg_failure_to_fatal` PASS.

- [ ] **Step 4: Commit**

```bash
git add ccli/src/encoder.rs ccli/src/lib.rs
git commit -m "feat(ccli): SegmentEncoder trait + LocalEncoder"
```

---

### Task 3: worker_client — capacity/encode + failure classification

**Files:**
- Create: `ccli/src/worker_client.rs`
- Modify: `ccli/src/lib.rs` (add `pub mod worker_client;`)

**Interfaces:**
- Produces:
  - `struct Capacity { pub cores: usize, pub slots: usize, pub svtav1: bool }`
  - `fn parse_capacity(body: &str) -> Result<Capacity, String>` (pure)
  - `fn capacity(base_url: &str) -> Result<Capacity, String>`
  - `fn encode(base_url: &str, preset: &str, cap1080: bool, body: &[u8]) -> Result<Vec<u8>, crate::encoder::EncodeErr>`

- [ ] **Step 1: Write the failing test in `ccli/src/worker_client.rs`**

```rust
// HTTP client for tinv-worker. Synchronous (ureq). Capacity JSON is our own
// minimal format, parsed by hand to avoid a JSON dependency.
use std::io::Read;
use std::time::Duration;

use crate::encoder::EncodeErr;

pub struct Capacity {
    pub cores: usize,
    pub slots: usize,
    pub svtav1: bool,
}

fn grab_num(body: &str, key: &str) -> Option<usize> {
    let k = format!("\"{}\":", key);
    let i = body.find(&k)? + k.len();
    let rest = body[i..].trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

pub fn parse_capacity(body: &str) -> Result<Capacity, String> {
    let cores = grab_num(body, "cores").ok_or("missing cores")?;
    let slots = grab_num(body, "slots").ok_or("missing slots")?;
    let svtav1 = body.contains("\"svtav1\":true");
    Ok(Capacity { cores, slots, svtav1 })
}

pub fn capacity(base_url: &str) -> Result<Capacity, String> {
    let resp = ureq::get(&format!("{base_url}/capacity"))
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?;
    let body = resp.into_string().map_err(|e| e.to_string())?;
    parse_capacity(&body)
}

pub fn encode(base_url: &str, preset: &str, cap1080: bool, body: &[u8]) -> Result<Vec<u8>, EncodeErr> {
    let url = format!("{base_url}/encode?preset={preset}&cap1080={}", if cap1080 { 1 } else { 0 });
    match ureq::post(&url).send_bytes(body) {
        Ok(resp) => {
            let mut v = Vec::new();
            resp.into_reader()
                .read_to_end(&mut v)
                .map_err(|e| EncodeErr::Transient(e.to_string()))?;
            Ok(v)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let msg = resp.into_string().unwrap_or_default();
            if (400..500).contains(&code) {
                Err(EncodeErr::Fatal(format!("worker {code}: {msg}")))
            } else {
                Err(EncodeErr::Transient(format!("worker {code}: {msg}")))
            }
        }
        Err(ureq::Error::Transport(t)) => Err(EncodeErr::Transient(t.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_capacity_json() {
        let c = parse_capacity("{\"cores\":12,\"slots\":4,\"svtav1\":true}").unwrap();
        assert_eq!(c.cores, 12);
        assert_eq!(c.slots, 4);
        assert!(c.svtav1);
    }

    #[test]
    fn capacity_without_svtav1_is_false() {
        let c = parse_capacity("{\"cores\":8,\"slots\":4,\"svtav1\":false}").unwrap();
        assert!(!c.svtav1);
    }

    #[test]
    fn missing_fields_error() {
        assert!(parse_capacity("{\"cores\":8}").is_err());
    }
}
```

- [ ] **Step 2: Register the module — add to `ccli/src/lib.rs`**

```rust
pub mod worker_client;
```

- [ ] **Step 3: Run tests**

Run: `cd ccli && cargo test worker_client::`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ccli/src/worker_client.rs ccli/src/lib.rs
git commit -m "feat(ccli): worker HTTP client + capacity parsing"
```

---

### Task 4: RemoteEncoder

**Files:**
- Modify: `ccli/src/encoder.rs` (add `RemoteEncoder`)

**Interfaces:**
- Consumes: `worker_client::encode`, `EncodeErr`.
- Produces: `struct RemoteEncoder { pub base_url: String }` implementing `SegmentEncoder`.

- [ ] **Step 1: Write the failing test (append to `ccli/src/encoder.rs` tests module)**

```rust
    #[test]
    fn remote_encoder_unreachable_is_transient() {
        // A worker that isn't listening → transport error → Transient (retryable),
        // never Fatal. Uses a port nothing is bound to.
        let enc = RemoteEncoder { base_url: "http://127.0.0.1:1".into() };
        // create a tiny real input file so the read() succeeds and we reach the POST
        let dir = std::env::temp_dir().join(format!("enc_rt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.mkv");
        std::fs::write(&src, b"not really mkv").unwrap();
        let r = enc.encode(&src, &dir.join("out.mp4"), preset("screencast").unwrap(), true);
        std::fs::remove_dir_all(&dir).ok();
        assert!(matches!(r, Err(EncodeErr::Transient(_))), "got {r:?}");
    }
```

- [ ] **Step 2: Add `RemoteEncoder` to `ccli/src/encoder.rs`**

After the `LocalEncoder` impl, add:

```rust
use crate::worker_client;

pub struct RemoteEncoder {
    pub base_url: String,
}

impl SegmentEncoder for RemoteEncoder {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr> {
        let body = std::fs::read(src).map_err(|e| EncodeErr::Fatal(format!("read {src:?}: {e}")))?;
        let out = worker_client::encode(&self.base_url, p.name, cap1080, &body)?;
        std::fs::write(dst, &out).map_err(|e| EncodeErr::Fatal(format!("write {dst:?}: {e}")))?;
        Ok(())
    }
}
```

- [ ] **Step 3: Run test**

Run: `cd ccli && cargo test encoder::`
Expected: `remote_encoder_unreachable_is_transient` and the local test PASS.

- [ ] **Step 4: Commit**

```bash
git add ccli/src/encoder.rs
git commit -m "feat(ccli): RemoteEncoder over worker HTTP client"
```

---

### Task 5: Resilient scheduler

**Files:**
- Create: `ccli/src/scheduler.rs`
- Modify: `ccli/src/lib.rs` (add `pub mod scheduler;`)

**Interfaces:**
- Consumes: `encoder::{SegmentEncoder, EncodeErr}`, `preset::Preset`.
- Produces:
  - `pub const MAX_REMOTE_ATTEMPTS: u32 = 2;`
  - `struct Executor { pub encoder: Box<dyn SegmentEncoder>, pub is_local: bool }`
  - `struct Job<'a> { pub src: &'a [PathBuf], pub dst: &'a [PathBuf], pub preset: &'a Preset, pub cap1080: bool }`
  - `fn run(job: &Job, executors: Vec<Executor>, on_done: &(dyn Fn(usize, usize) + Sync)) -> Result<(), String>`

- [ ] **Step 1: Write the failing tests in `ccli/src/scheduler.rs`**

```rust
// Resilient scheduler: runs segment indices across executors. Remote executors
// take "normal" tasks; local executors take local-only fallbacks first, then
// normal. Transient failures requeue (after MAX_REMOTE_ATTEMPTS, local-only).
// A fatal failure aborts the whole job.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::encoder::{EncodeErr, SegmentEncoder};
use crate::preset::Preset;

pub const MAX_REMOTE_ATTEMPTS: u32 = 2;

pub struct Executor {
    pub encoder: Box<dyn SegmentEncoder>,
    pub is_local: bool,
}

pub struct Job<'a> {
    pub src: &'a [PathBuf],
    pub dst: &'a [PathBuf],
    pub preset: &'a Preset,
    pub cap1080: bool,
}

struct Task {
    idx: usize,
    attempts: u32,
}

pub fn run(
    job: &Job,
    executors: Vec<Executor>,
    on_done: &(dyn Fn(usize, usize) + Sync),
) -> Result<(), String> {
    let total = job.src.len();
    let normal: Mutex<VecDeque<Task>> =
        Mutex::new((0..total).map(|idx| Task { idx, attempts: 0 }).collect());
    let local_q: Mutex<VecDeque<Task>> = Mutex::new(VecDeque::new());
    let remaining = AtomicUsize::new(total);
    let done = AtomicUsize::new(0);
    let abort = AtomicBool::new(false);
    let err: Mutex<Option<String>> = Mutex::new(None);
    let has_local = executors.iter().any(|e| e.is_local);

    std::thread::scope(|s| {
        for ex in &executors {
            s.spawn(|| {
                let mut consecutive = 0u32;
                while !abort.load(Ordering::Relaxed) && remaining.load(Ordering::Relaxed) > 0 {
                    let task = if ex.is_local {
                        local_q.lock().unwrap().pop_front()
                            .or_else(|| normal.lock().unwrap().pop_front())
                    } else {
                        normal.lock().unwrap().pop_front()
                    };
                    let mut task = match task {
                        Some(t) => t,
                        None => {
                            std::thread::sleep(Duration::from_millis(25));
                            continue;
                        }
                    };
                    match ex.encoder.encode(&job.src[task.idx], &job.dst[task.idx], job.preset, job.cap1080) {
                        Ok(()) => {
                            consecutive = 0;
                            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                            remaining.fetch_sub(1, Ordering::Relaxed);
                            on_done(d, total);
                        }
                        Err(EncodeErr::Fatal(m)) => {
                            *err.lock().unwrap() = Some(m);
                            abort.store(true, Ordering::Relaxed);
                        }
                        Err(EncodeErr::Transient(_)) => {
                            consecutive += 1;
                            task.attempts += 1;
                            if task.attempts >= MAX_REMOTE_ATTEMPTS && has_local {
                                local_q.lock().unwrap().push_back(task);
                            } else {
                                normal.lock().unwrap().push_back(task);
                            }
                            std::thread::sleep(Duration::from_millis(50));
                            if consecutive >= 3 && !ex.is_local {
                                break; // stop hammering a dead remote worker
                            }
                        }
                    }
                }
            });
        }
    });

    if let Some(e) = err.into_inner().unwrap() {
        return Err(e);
    }
    if remaining.load(Ordering::Relaxed) != 0 {
        return Err("encode incomplete: all workers failed with no local fallback".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::preset;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Fake encoder driven by a closure over the segment index.
    struct Fake<F: Fn(usize) -> Result<(), EncodeErr> + Send + Sync>(F);
    impl<F: Fn(usize) -> Result<(), EncodeErr> + Send + Sync> SegmentEncoder for Fake<F> {
        fn encode(&self, src: &std::path::Path, _dst: &std::path::Path, _p: &Preset, _c: bool) -> Result<(), EncodeErr> {
            // recover the index from the filename "seg_<n>"
            let n: usize = src.file_stem().unwrap().to_string_lossy()
                .strip_prefix("seg_").unwrap().parse().unwrap();
            (self.0)(n)
        }
    }

    fn job_paths(n: usize) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let src = (0..n).map(|i| PathBuf::from(format!("seg_{i}"))).collect();
        let dst = (0..n).map(|i| PathBuf::from(format!("out_{i}"))).collect();
        (src, dst)
    }

    fn noop(_d: usize, _t: usize) {}

    #[test]
    fn all_segments_encoded_once_on_success() {
        use std::sync::Arc;
        let n = 20;
        let (src, dst) = job_paths(n);
        let job = Job { src: &src, dst: &dst, preset: preset("screencast").unwrap(), cap1080: true };
        let counts = Arc::new((0..n).map(|_| AtomicUsize::new(0)).collect::<Vec<_>>());
        let mk = |c: Arc<Vec<AtomicUsize>>| Executor {
            is_local: false,
            encoder: Box::new(Fake(move |i| {
                c[i].fetch_add(1, Ordering::Relaxed);
                Ok(())
            })),
        };
        // 3 remote-style executors; every segment must be encoded exactly once.
        run(&job, vec![mk(counts.clone()), mk(counts.clone()), mk(counts.clone())], &noop).unwrap();
        for c in counts.iter() {
            assert_eq!(c.load(Ordering::Relaxed), 1, "each segment encoded exactly once");
        }
    }

    #[test]
    fn fatal_failure_aborts() {
        let (src, dst) = job_paths(10);
        let job = Job { src: &src, dst: &dst, preset: preset("screencast").unwrap(), cap1080: true };
        let r = run(
            &job,
            vec![Executor { is_local: false, encoder: Box::new(Fake(|i| {
                if i == 3 { Err(EncodeErr::Fatal("bad input".into())) } else { Ok(()) }
            })) }],
            &noop,
        );
        assert!(r.unwrap_err().contains("bad input"));
    }

    #[test]
    fn transient_then_falls_back_to_local() {
        // The only remote always fails transiently; a local executor must pick up
        // the local-only requeues and complete the job.
        let (src, dst) = job_paths(5);
        let job = Job { src: &src, dst: &dst, preset: preset("screencast").unwrap(), cap1080: true };
        let remote = Executor { is_local: false, encoder: Box::new(Fake(|_| Err(EncodeErr::Transient("down".into())))) };
        let local = Executor { is_local: true, encoder: Box::new(Fake(|_| Ok(()))) };
        run(&job, vec![remote, local], &noop).unwrap();
    }

    #[test]
    fn no_executor_can_finish_returns_error() {
        let (src, dst) = job_paths(3);
        let job = Job { src: &src, dst: &dst, preset: preset("screencast").unwrap(), cap1080: true };
        // single remote that always fails transiently, no local backstop
        let remote = Executor { is_local: false, encoder: Box::new(Fake(|_| Err(EncodeErr::Transient("down".into())))) };
        let r = run(&job, vec![remote], &noop);
        assert!(r.unwrap_err().contains("incomplete"));
    }
}
```

- [ ] **Step 2: Register the module — add to `ccli/src/lib.rs`**

```rust
pub mod scheduler;
```

- [ ] **Step 3: Run tests**

Run: `cd ccli && cargo test scheduler::`
Expected: 4 tests PASS. (`no_executor_can_finish_returns_error` confirms the run terminates rather than hanging when a lone remote dies.)

- [ ] **Step 4: Commit**

```bash
git add ccli/src/scheduler.rs ccli/src/lib.rs
git commit -m "feat(ccli): resilient segment scheduler with local fallback"
```

---

### Task 6: Wire scheduler into the pipeline

**Files:**
- Modify: `ccli/src/pipeline.rs` (`Opts`, `encode_chunked`)

**Interfaces:**
- Consumes: `scheduler::{run, Executor, Job}`, `encoder::{LocalEncoder, RemoteEncoder}`.
- Produces: `Opts` gains `pub workers: Vec<WorkerSlot>` where `pub struct WorkerSlot { pub base_url: String, pub slots: usize }`. `encode_chunked` builds executors (local `jobs`× + remote slots) and calls `scheduler::run`.

- [ ] **Step 1: Add `WorkerSlot` + field to `Opts` in `ccli/src/pipeline.rs`**

Add near the top (after imports):

```rust
use ccli::encoder::{LocalEncoder, RemoteEncoder};
use ccli::scheduler::{self, Executor, Job};

#[derive(Clone)]
pub struct WorkerSlot {
    pub base_url: String,
    pub slots: usize,
}
```

Add to `Opts`:

```rust
    pub workers: Vec<WorkerSlot>,
```

- [ ] **Step 2: Replace the segment-encode block in `encode_chunked`**

Find the `pool::run_pool(total, opts.jobs, &abort, |i| { … })?;` block and replace it (and its surrounding `done`/`abort` setup) with:

```rust
    // 2. Encode each segment to AV1 video-only across local + remote executors.
    let enc_segs: Vec<PathBuf> = (0..total).map(|i| work.join(format!("enc_{:04}.mp4", i))).collect();

    let mut executors: Vec<Executor> = Vec::new();
    for _ in 0..opts.jobs {
        executors.push(Executor {
            is_local: true,
            encoder: Box::new(LocalEncoder { ffmpeg: opts.ffmpeg.clone(), lp: opts.lp }),
        });
    }
    for w in &opts.workers {
        for _ in 0..w.slots {
            executors.push(Executor {
                is_local: false,
                encoder: Box::new(RemoteEncoder { base_url: w.base_url.clone() }),
            });
        }
    }

    let done = std::sync::atomic::AtomicUsize::new(0);
    let job = Job { src: &src_segs, dst: &enc_segs, preset: p, cap1080: opts.cap1080 };
    let report = |_d: usize, _t: usize| {
        let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        progress.segment(n, total);
    };
    scheduler::run(&job, executors, &report)?;
```

Remove the now-unused `use ccli::pool;` import only if `pool` is otherwise unused in this file (it is — `run_pool` was the only use). Keep `use ccli::ffmpeg;`.

- [ ] **Step 3: Build and run the existing interop test (local-only path unchanged)**

Run: `cd ccli && cargo build`
Expected: builds clean.

Run: `cd /Users/zaahead/Documents/GitHub/tinv && cargo build --release --manifest-path ccli/Cargo.toml && node --test cli/ccli-interop.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# pass 2`, `# fail 0` — the local path now runs through the scheduler and still produces playable TINV3.

- [ ] **Step 4: Update `main.rs` to populate the new `Opts.workers` field (empty for now)**

In `ccli/src/main.rs`, in the `Opts { … }` construction, add:

```rust
            workers: Vec::new(),
```

Run: `cd ccli && cargo build`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add ccli/src/pipeline.rs ccli/src/main.rs
git commit -m "feat(ccli): run segment encode through the resilient scheduler"
```

---

### Task 7: tinv-worker server

**Files:**
- Create: `ccli/src/worker.rs` (pure request helpers)
- Modify: `ccli/src/lib.rs` (add `pub mod worker;`)
- Replace: `ccli/src/bin/tinv-worker.rs` (real server)

**Interfaces:**
- Consumes: `ffmpeg`, `preset`, `pool`.
- Produces:
  - `fn parse_encode_query(url: &str) -> Result<(String, bool), String>` returning `(preset, cap1080)`.
  - `fn capacity_json(cores: usize, slots: usize, svtav1: bool) -> String`.

- [ ] **Step 1: Write the failing tests in `ccli/src/worker.rs`**

```rust
// Pure request helpers for tinv-worker, kept separate from the server loop so
// they can be unit-tested without sockets.

/// Parse `/encode?preset=<name>&cap1080=<0|1>` → (preset, cap1080).
pub fn parse_encode_query(url: &str) -> Result<(String, bool), String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut preset: Option<String> = None;
    let mut cap1080 = true;
    for pair in q.split('&') {
        match pair.split_once('=') {
            Some(("preset", v)) => preset = Some(v.to_string()),
            Some(("cap1080", v)) => cap1080 = v != "0",
            _ => {}
        }
    }
    preset.map(|p| (p, cap1080)).ok_or_else(|| "missing preset".into())
}

pub fn capacity_json(cores: usize, slots: usize, svtav1: bool) -> String {
    format!("{{\"cores\":{cores},\"slots\":{slots},\"svtav1\":{svtav1}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_encode_query() {
        assert_eq!(parse_encode_query("/encode?preset=near&cap1080=0").unwrap(), ("near".into(), false));
        assert_eq!(parse_encode_query("/encode?preset=screencast&cap1080=1").unwrap(), ("screencast".into(), true));
        assert_eq!(parse_encode_query("/encode?preset=squeeze").unwrap(), ("squeeze".into(), true));
    }

    #[test]
    fn missing_preset_errors() {
        assert!(parse_encode_query("/encode?cap1080=1").is_err());
    }

    #[test]
    fn capacity_json_shape() {
        assert_eq!(capacity_json(12, 4, true), "{\"cores\":12,\"slots\":4,\"svtav1\":true}");
    }
}
```

- [ ] **Step 2: Register module — add to `ccli/src/lib.rs`**

```rust
pub mod worker;
```

- [ ] **Step 3: Run tests**

Run: `cd ccli && cargo test worker::`
Expected: 3 tests PASS.

- [ ] **Step 4: Replace `ccli/src/bin/tinv-worker.rs` with the server**

```rust
// tinv-worker — stateless HTTP encode worker. Runs the same segment encode as
// the local path. Concurrency is bounded by the coordinator (it opens at most
// `slots` connections); we spawn a thread per request.
//
//   tinv-worker [bind_addr]   (default 0.0.0.0:7878)
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};

use ccli::{ffmpeg, pool, preset, worker};
use tiny_http::{Method, Response, Server};

fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "0.0.0.0:7878".into());
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let slots = pool::default_jobs(cores);
    let lp = pool::lp_for(cores, slots);
    let ffmpeg_bin = ffmpeg::resolve_bin("ffmpeg");
    let svtav1 = ffmpeg::has_svtav1(&ffmpeg_bin);

    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("tinv-worker: cannot bind {addr}: {e}");
        std::process::exit(1);
    });
    eprintln!("tinv-worker on {addr}: cores={cores} slots={slots} lp={lp} svtav1={svtav1}");

    static SEQ: AtomicU64 = AtomicU64::new(0);

    for mut req in server.incoming_requests() {
        let ffmpeg_bin = ffmpeg_bin.clone();
        std::thread::spawn(move || {
            let url = req.url().to_string();
            let is_capacity = req.method() == &Method::Get && url.starts_with("/capacity");
            let is_encode = req.method() == &Method::Post && url.starts_with("/encode");

            if is_capacity {
                let body = worker::capacity_json(cores, slots, svtav1);
                let _ = req.respond(Response::from_string(body).with_status_code(200));
                return;
            }
            if !is_encode {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
                return;
            }

            let (preset_name, cap1080) = match worker::parse_encode_query(&url) {
                Ok(v) => v,
                Err(e) => {
                    let _ = req.respond(Response::from_string(e).with_status_code(400));
                    return;
                }
            };
            let p = match preset::preset(&preset_name) {
                Some(p) => p,
                None => {
                    let _ = req.respond(Response::from_string("unknown preset").with_status_code(400));
                    return;
                }
            };

            // Read the uploaded segment to a temp .mkv.
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!("tinvw_{}_{}", std::process::id(), n));
            let src = base.with_extension("mkv");
            let dst = base.with_extension("mp4");
            let mut bytes = Vec::new();
            if req.as_reader().read_to_end(&mut bytes).is_err() {
                let _ = req.respond(Response::from_string("read body failed").with_status_code(400));
                return;
            }
            if std::fs::write(&src, &bytes).is_err() {
                let _ = req.respond(Response::from_string("temp write failed").with_status_code(500));
                return;
            }

            let abort = std::sync::atomic::AtomicBool::new(false);
            let args = ffmpeg::segment_encode_args(&src.to_string_lossy(), &dst.to_string_lossy(), p, cap1080, lp);
            let result = ffmpeg::run_ffmpeg(&ffmpeg_bin, &args, &abort);

            let response = match result {
                Ok(()) => match std::fs::read(&dst) {
                    Ok(out) => Response::from_data(out).with_status_code(200),
                    Err(e) => Response::from_string(format!("read output: {e}")).with_status_code(500),
                },
                // ffmpeg rejected the segment → client must not retry: 400 (fatal).
                Err(e) => Response::from_string(e).with_status_code(400),
            };
            let _ = req.respond(response);
            let _ = std::fs::remove_file(&src);
            let _ = std::fs::remove_file(&dst);
        });
    }
}
```

- [ ] **Step 5: Build**

Run: `cd ccli && cargo build --release`
Expected: both `tinv` and `tinv-worker` build.

- [ ] **Step 6: Smoke-test capacity by hand**

Run:
```bash
./ccli/target/release/tinv-worker 127.0.0.1:7901 & sleep 1
curl -s http://127.0.0.1:7901/capacity; echo
kill %1
```
Expected: a line like `{"cores":N,"slots":4,"svtav1":true}`.

- [ ] **Step 7: Commit**

```bash
git add ccli/src/worker.rs ccli/src/lib.rs ccli/src/bin/tinv-worker.rs
git commit -m "feat(ccli): tinv-worker http encode server"
```

---

### Task 8: `--workers` flag on the coordinator

**Files:**
- Modify: `ccli/src/main.rs` (parse `--workers`, pre-flight `/capacity`, build `WorkerSlot`s, header line)

**Interfaces:**
- Consumes: `worker_client::capacity`, `pipeline::WorkerSlot`.
- Produces: coordinator populates `Opts.workers` from reachable workers; header shows the cluster.

- [ ] **Step 1: Add `workers` to the `Args` struct and parse it**

In `ccli/src/main.rs`, add to `struct Args`:

```rust
    workers: Vec<String>,
```

Initialize in `parse_args` defaults:

```rust
        workers: Vec::new(),
```

Add a match arm (before the catch-all `other =>`):

```rust
            "--workers" => { i += 1; if let Some(v) = argv.get(i) { a.workers = v.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(); } }
```

- [ ] **Step 2: Pre-flight workers and build slots in `main()`**

After computing `lp` and before the header `println!`, add:

```rust
    use ccli::worker_client;
    let mut worker_slots: Vec<pipeline::WorkerSlot> = Vec::new();
    let mut remote_slot_total = 0usize;
    for raw in &args.workers {
        let base_url = if raw.starts_with("http") { raw.clone() } else { format!("http://{raw}") };
        match worker_client::capacity(&base_url) {
            Ok(c) if c.svtav1 && c.slots > 0 => {
                remote_slot_total += c.slots;
                worker_slots.push(pipeline::WorkerSlot { base_url, slots: c.slots });
            }
            Ok(_) => eprintln!("  ! worker {base_url} has no usable SVT-AV1 encoder; skipping"),
            Err(e) => eprintln!("  ! worker {base_url} unreachable ({e}); skipping"),
        }
    }
```

- [ ] **Step 3: Update the header line**

Replace the existing `println!("tinv: …")` with:

```rust
    let cluster = if worker_slots.is_empty() {
        String::new()
    } else {
        format!(", workers={} ({} remote + {} local slots)", worker_slots.len(), remote_slot_total, args.jobs)
    };
    println!(
        "tinv: {} file(s), preset={}, jobs={}, lp={}{}, segment={}s, min-split={}s",
        args.inputs.len(), args.preset, args.jobs, lp, cluster, args.seg_len as i64, args.min_split as i64
    );
```

- [ ] **Step 4: Pass slots into `Opts`**

Change the `Opts { … workers: Vec::new(), … }` line (from Task 6 Step 4) to:

```rust
            workers: worker_slots.clone(),
```

- [ ] **Step 5: Build**

Run: `cd ccli && cargo build --release`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add ccli/src/main.rs
git commit -m "feat(ccli): --workers flag with capacity pre-flight"
```

---

### Task 9: Loopback integration + resilience tests

**Files:**
- Create: `cli/ccli-dist-interop.test.js`

**Interfaces:**
- Consumes: built `ccli/target/release/{tinv,tinv-worker}`, `web/tinv-format.js` `decodeTinv`, `cli/ffmpeg.js` `{runFfmpeg, hasSvtAv1, FFMPEG, FFPROBE}`.

- [ ] **Step 1: Write the integration test `cli/ccli-dist-interop.test.js`**

```javascript
// cli/ccli-dist-interop.test.js
// Distributed path: run the coordinator against a loopback tinv-worker and
// assert the output decodes as valid fMP4 via the web module. Also verify the
// job survives a worker dying mid-run (local fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

import { runFfmpeg, hasSvtAv1, FFMPEG, FFPROBE } from "./ffmpeg.js";
import { decodeTinv } from "../web/tinv-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TINV = join(__dirname, "..", "ccli", "target", "release", "tinv");
const WORKER = join(__dirname, "..", "ccli", "target", "release", "tinv-worker");

const ffOk = hasSvtAv1();
const binOk = await Promise.all([access(TINV), access(WORKER)]).then(() => true).catch(() => false);
const skip = !ffOk ? "ffmpeg/libsvtav1 unavailable" : !binOk ? "ccli binaries not built" : false;

function freePort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

function startWorker(port) {
  const env = { ...process.env, TINV_FFMPEG: FFMPEG, TINV_FFPROBE: FFPROBE };
  const proc = spawn(WORKER, [`127.0.0.1:${port}`], { env, stdio: "ignore" });
  return proc;
}

async function waitForCapacity(port, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/capacity`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("worker did not come up");
}

async function makeClip(dir, seconds) {
  const src = join(dir, "clip.mp4");
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, src,
  ]);
  return src;
}

function runCoordinator(args) {
  const r = spawnSync(TINV, args, {
    encoding: "utf8",
    env: { ...process.env, TINV_FFMPEG: FFMPEG, TINV_FFPROBE: FFPROBE },
  });
  assert.equal(r.status, 0, `coordinator failed: ${r.stderr || r.stdout}`);
  return r;
}

async function assertPlayable(tinvPath) {
  const bytes = new Uint8Array(await readFile(tinvPath));
  const r = await decodeTinv(bytes);
  assert.ok(r && r.blob, "web module failed to decode distributed output");
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  assert.equal(String.fromCharCode(buf[4], buf[5], buf[6], buf[7]), "ftyp");
}

test("distributed encode via loopback worker decodes as valid fMP4", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccli_dist_"));
  const port = await freePort();
  const w = startWorker(port);
  try {
    await waitForCapacity(port);
    const src = await makeClip(dir, 3);
    const dst = join(dir, "clip.tinv");
    runCoordinator([src, "--preset", "talkinghead", "--segment", "1", "--min-split", "0", "--jobs", "1", "--workers", `127.0.0.1:${port}`, "-o", dst]);
    await assertPlayable(dst);
  } finally {
    w.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("job completes via local fallback when the worker dies mid-run", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccli_dist_kill_"));
  const port = await freePort();
  const w = startWorker(port);
  try {
    await waitForCapacity(port);
    const src = await makeClip(dir, 4);
    const dst = join(dir, "clip.tinv");
    // Kill the worker shortly after the coordinator starts; local executors
    // (--jobs 2) must finish the job.
    const env = { ...process.env, TINV_FFMPEG: FFMPEG, TINV_FFPROBE: FFPROBE };
    const proc = spawn(TINV, [src, "--preset", "talkinghead", "--segment", "1", "--min-split", "0", "--jobs", "2", "--workers", `127.0.0.1:${port}`, "-o", dst], { env, stdio: "ignore" });
    setTimeout(() => w.kill("SIGKILL"), 600);
    const code = await new Promise((res) => proc.on("exit", res));
    assert.equal(code, 0, "coordinator should still succeed after worker death");
    await assertPlayable(dst);
  } finally {
    w.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Build release binaries and run the integration tests**

Run:
```bash
cd /Users/zaahead/Documents/GitHub/tinv
cargo build --release --manifest-path ccli/Cargo.toml
node --test cli/ccli-dist-interop.test.js 2>&1 | grep -E '^(ok|not ok|# (tests|pass|fail|skipped))'
```
Expected: `ok 1 …`, `ok 2 …`, `# pass 2`, `# fail 0`.

- [ ] **Step 3: Full regression sweep**

Run:
```bash
cd /Users/zaahead/Documents/GitHub/tinv
(cd ccli && cargo test 2>&1 | grep 'test result')
for f in cli/pool.test.js cli/pipeline.test.js cli/ffmpeg.test.js cli/interop.test.js cli/ccli-interop.test.js cli/ccli-dist-interop.test.js; do
  printf "%-26s " "$(basename $f)"; node --test "$f" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
done
```
Expected: Rust `test result: ok`; every JS file `# pass N # fail 0`.

- [ ] **Step 4: Commit**

```bash
git add cli/ccli-dist-interop.test.js
git commit -m "test(ccli): loopback distributed encode + worker-death resilience"
```

---

### Task 10: Documentation

**Files:**
- Modify: `ccli/README.md` (distributed usage + worker section)

- [ ] **Step 1: Append a "Distributed encoding" section to `ccli/README.md`**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add ccli/README.md
git commit -m "docs(ccli): distributed encoding usage"
```

---

## Self-Review

**1. Spec coverage:**
- Worker protocol (`/capacity`, `/encode`, no `lp`, 4xx/5xx semantics) → Tasks 3, 7. ✓
- `SegmentEncoder` + Local/Remote → Tasks 2, 4. ✓
- Resilient scheduler (requeue, local-only fallback, fatal abort, MAX_REMOTE_ATTEMPTS) → Task 5. ✓
- Pipeline seam swap, unchanged split/concat/mux/TINV3 → Task 6. ✓
- `--workers` flag, capacity pre-flight, header → Task 8. ✓
- Local-only path unchanged → Task 6 Step 3 (existing interop still green). ✓
- Integration + resilience tests → Task 9. ✓
- Docs + security note → Task 10. ✓
- Library restructure to share modules between bins → Task 1. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has full code; every command has expected output. ✓

**3. Type consistency:** `EncodeErr` (Task 2) used by `worker_client` (3), `RemoteEncoder` (4), `scheduler` (5). `Executor`/`Job` defined in Task 5, consumed in Task 6. `WorkerSlot{base_url, slots}` defined Task 6, populated Task 8. `Capacity{cores,slots,svtav1}` defined Task 3, used Task 8. `parse_encode_query`/`capacity_json` defined Task 7, used in the same task's server. `preset.name` field used as `preset` query param — exists on the `Preset` struct. ✓

**Note on `pool::run_pool`:** after Task 6 it is unused by the coordinator but remains a tested public library function; leaving it is intentional (no dead-code removal needed since it is `pub`).
