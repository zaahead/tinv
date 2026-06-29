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
