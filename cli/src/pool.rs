// Pure concurrency helpers + a bounded worker pool for the local encoder.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

/// Default number of concurrent encodes. Each encode is a fully multithreaded
/// SVT-AV1 process, so running one per logical core oversubscribes the CPU and
/// thrashes. A small fixed cap keeps a few encodes in flight while leaving each
/// real threads to work with.
pub fn default_jobs(cores: usize) -> usize {
    cores.min(4).max(1)
}

/// SVT-AV1 level-of-parallelism (threads per encode) for a job count, so that
/// jobs × lp ≈ cores at ANY `--jobs` value instead of every encode grabbing all
/// cores.
pub fn lp_for(cores: usize, jobs: usize) -> usize {
    (cores / jobs.max(1)).max(1)
}

/// Run `n` indexed tasks through at most `jobs` OS threads. Returns the first
/// error and sets `abort` so in-flight tasks can stop their children. `f` is
/// called with each index in `0..n` exactly once (until an error aborts the run).
pub fn run_pool<F>(n: usize, jobs: usize, abort: &AtomicBool, f: F) -> Result<(), String>
where
    F: Fn(usize) -> Result<(), String> + Sync,
{
    let next = AtomicUsize::new(0);
    let err: Mutex<Option<String>> = Mutex::new(None);
    let workers = jobs.clamp(1, n.max(1));

    std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| loop {
                    if abort.load(Ordering::Relaxed) {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= n {
                        break;
                    }
                    if let Err(e) = f(i) {
                        *err.lock().unwrap() = Some(e);
                        abort.store(true, Ordering::Relaxed);
                        break;
                    }
                })
            })
            .collect();
        for h in handles {
            let _ = h.join();
        }
    });

    match err.into_inner().unwrap() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_jobs_caps_at_four() {
        assert_eq!(default_jobs(16), 4);
        assert_eq!(default_jobs(8), 4);
        assert_eq!(default_jobs(2), 2);
        assert_eq!(default_jobs(1), 1);
        assert_eq!(default_jobs(0), 1);
    }

    #[test]
    fn lp_splits_cores_across_jobs() {
        assert_eq!(lp_for(16, 4), 4);
        assert_eq!(lp_for(16, 16), 1);
        assert_eq!(lp_for(12, 4), 3);
        assert_eq!(lp_for(8, 3), 2);
        assert_eq!(lp_for(4, 8), 1);
    }

    #[test]
    fn run_pool_runs_every_task() {
        let count = AtomicUsize::new(0);
        let abort = AtomicBool::new(false);
        run_pool(50, 4, &abort, |_| {
            count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 50);
    }

    #[test]
    fn run_pool_reports_error_and_aborts() {
        let abort = AtomicBool::new(false);
        let r = run_pool(100, 4, &abort, |i| {
            if i == 7 {
                Err("boom".into())
            } else {
                Ok(())
            }
        });
        assert!(r.unwrap_err().contains("boom"));
        assert!(abort.load(Ordering::Relaxed));
    }
}
