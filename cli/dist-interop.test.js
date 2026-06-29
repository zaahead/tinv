// cli/dist-interop.test.js
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

import { runFfmpeg, hasSvtAv1, FFMPEG, FFPROBE } from "./test-support.mjs";
import { decodeTinv } from "../web/tinv-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TINV = join(__dirname, "target", "release", "tinv");
const WORKER = join(__dirname, "target", "release", "tinv-worker");

const ffOk = hasSvtAv1();
const binOk = await Promise.all([access(TINV), access(WORKER)]).then(() => true).catch(() => false);
const skip = !ffOk ? "ffmpeg/libsvtav1 unavailable" : !binOk ? "tinv binaries not built" : false;

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
  const dir = await mkdtemp(join(tmpdir(), "tinv_dist_"));
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
  const dir = await mkdtemp(join(tmpdir(), "tinv_dist_kill_"));
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
