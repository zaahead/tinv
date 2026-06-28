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
