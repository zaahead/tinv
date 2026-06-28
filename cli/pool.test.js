import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSemaphore, runPool } from "./pool.js";

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
