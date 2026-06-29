import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSemaphore, runPool, defaultJobs, lpFor } from "./pool.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("makeSemaphore never exceeds the limit", async () => {
  const sem = makeSemaphore(3);
  let active = 0, max = 0;
  const job = () => sem.run(async () => {
    active++; max = Math.max(max, active);
    await delay(15);
    active--;
  });
  await Promise.all(Array.from({ length: 12 }, job));
  assert.ok(max <= 3, `max concurrency was ${max}, expected <= 3`);
});

test("runPool returns results in input order", async () => {
  const tasks = [10, 1, 5].map((ms, i) => async () => { await delay(ms); return i; });
  const out = await runPool(tasks, 2);
  assert.deepEqual(out, [0, 1, 2]);
});

test("runPool rejects on a task error", async () => {
  const tasks = [
    async () => 1,
    async () => { throw new Error("boom"); },
    async () => 3,
  ];
  await assert.rejects(() => runPool(tasks, 2), /boom/);
});

test("defaultJobs caps at 4 so parallel encodes don't oversubscribe", () => {
  assert.equal(defaultJobs(16), 4);
  assert.equal(defaultJobs(8), 4);
  assert.equal(defaultJobs(2), 2);
  assert.equal(defaultJobs(1), 1);
  assert.equal(defaultJobs(0), 1);
});

test("lpFor splits cores across jobs so jobs*lp ~= cores, floored at 1", () => {
  assert.equal(lpFor(16, 4), 4);
  assert.equal(lpFor(16, 16), 1); // explicit --jobs 16 stays at one thread each
  assert.equal(lpFor(12, 4), 3);
  assert.equal(lpFor(8, 3), 2);
  assert.equal(lpFor(4, 8), 1); // more jobs than cores still floors at 1
});
