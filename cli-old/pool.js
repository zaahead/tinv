// Pure concurrency primitives for the local encoder. No ffmpeg knowledge.

/**
 * A counting semaphore. `run(fn)` waits for a free permit, runs fn, releases the
 * permit when fn settles. At most `limit` fns run concurrently.
 */
export function makeSemaphore(limit) {
  const cap = Math.max(1, limit | 0);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < cap && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(
        (v) => { active--; resolve(v); pump(); },
        (e) => { active--; reject(e); pump(); },
      );
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
  };
}

/**
 * Run an array of task thunks through one semaphore. Resolves to results in the
 * same order as `tasks`; rejects on the first task error.
 */
export async function runPool(tasks, limit) {
  const sem = makeSemaphore(limit);
  return Promise.all(tasks.map((t) => sem.run(t)));
}

/**
 * Default number of concurrent encodes. Each encode is a fully multithreaded
 * SVT-AV1 process, so running one per logical core oversubscribes the CPU
 * (N encoders × ~N threads on N cores) and thrashes. A small fixed cap keeps a
 * few encodes in flight while leaving each one real threads to work with.
 */
export function defaultJobs(cores) {
  return Math.max(1, Math.min(4, cores | 0));
}

/**
 * SVT-AV1 level-of-parallelism (threads per encode) for a given job count, so
 * that jobs × lp ≈ cores. This makes total encoder threads track the core count
 * at ANY `--jobs` value, instead of every encode grabbing all cores.
 */
export function lpFor(cores, jobs) {
  return Math.max(1, Math.floor((cores | 0) / Math.max(1, jobs)));
}
