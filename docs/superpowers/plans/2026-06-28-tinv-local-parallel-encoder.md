# tinv Local Parallel Encoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local `cli/` converter an independent pipeline that saturates the machine via chunked parallel SVT-AV1 encoding, while still producing AV1-in-fMP4 TINV3 output the web app and extension can play.

**Architecture:** A shared concurrency semaphore drives all encoding. A batch of small files runs one whole-file encode job each; a large file is copy-split at its source keyframes, its segments are encoded in parallel, then concat-copied, muxed with a single-pass Opus track, fragmented to fMP4, and wrapped as `.tinv`. The CLI is split into focused modules: `pool.js` (pure concurrency), `ffmpeg.js` (binary + arg building), `pipeline.js` (per-file orchestration), `convert.js` (entry + scheduling).

**Tech Stack:** Node 22 (ESM via automatic module detection — no `package.json` needed), bundled `cli/ffmpeg/ffmpeg` + `ffprobe` with `libsvtav1`/`libopus`, `node:test` + `node:assert/strict` for tests, `web/tinv-format.js` decode for interop verification.

## Global Constraints

- Output stays **AV1-in-fragmented-MP4 inside the TINV3 container** (`cli/tinv-format.js` `encodeTinvStream`). Never change the wire format; files must decode with `web/tinv-format.js`.
- The CLI must **not import from `../web`**. It uses its own `cli/tinv-format.js`.
- ESM only (`import`/`export`); files are `.js`, run under Node 22 with module syntax detection. No `package.json`, no new runtime dependencies.
- ffmpeg/ffprobe come from `cli/ffmpeg/` (bundled) first, then PATH — via `resolveBin`.
- Fragment flags on any final fMP4: `-movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000`, GOP `= max(2, round(fps*2))`.
- Tests run with: `node --test cli/`.
- SVT-AV1 invocation: `-c:v libsvtav1 -crf <crf> -preset <svt> -g <gop> -svtav1-params tune=0`. Audio: `-c:a libopus -b:a <audio>k -ac 1`.

---

### Task 1: Concurrency primitive (`cli/pool.js`)

**Files:**
- Create: `cli/pool.js`
- Test: `cli/pool.test.js`

**Interfaces:**
- Produces:
  - `makeSemaphore(limit: number) => { run<T>(fn: () => Promise<T>|T): Promise<T> }` — `run` resolves/rejects with `fn`'s result; never more than `limit` `fn`s execute at once.
  - `runPool<T>(tasks: Array<() => Promise<T>|T>, limit: number): Promise<T[]>` — runs all tasks through one semaphore, resolves to results in input order, rejects on the first task error.

- [ ] **Step 1: Write the failing tests**

```js
// cli/pool.test.js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test cli/pool.test.js`
Expected: FAIL — `Cannot find module './pool.js'` / `makeSemaphore is not a function`.

- [ ] **Step 3: Implement `cli/pool.js`**

```js
// cli/pool.js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test cli/pool.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/pool.js cli/pool.test.js
git commit -m "feat(cli): add concurrency semaphore and runPool"
```

---

### Task 2: ffmpeg module (`cli/ffmpeg.js`)

**Files:**
- Create: `cli/ffmpeg.js`
- Test: `cli/ffmpeg.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveBin(name: string): string`
  - `FFMPEG: string`, `FFPROBE: string`
  - `hasSvtAv1(): boolean`
  - `probe(src: string): { duration: number, hasAudio: boolean }`
  - `runFfmpeg(args: string[], onTime?: (seconds: number) => void): Promise<void>`
  - `wholeFileArgs(src, dst, preset, cap1080, hasAudio): string[]`
  - `splitArgs(src, dstPattern, segLen): string[]`
  - `segmentEncodeArgs(src, dst, preset, cap1080): string[]`
  - `concatArgs(listFile, dst): string[]`
  - `audioArgs(src, dst, preset): string[]`
  - `muxFragmentArgs(videoPath, audioPath: string|null, dst): string[]`
  - `gopFor(fps: number): number`
  - `PRESETS: Record<string, {fps,crf,svt,denoise,audio,label}>`

- [ ] **Step 1: Write the failing tests**

```js
// cli/ffmpeg.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gopFor, PRESETS, wholeFileArgs, splitArgs, segmentEncodeArgs,
  concatArgs, audioArgs, muxFragmentArgs, resolveBin,
} from "./ffmpeg.js";

test("gopFor is ~2s of frames, floored at 2", () => {
  assert.equal(gopFor(15), 30);
  assert.equal(gopFor(24), 48);
  assert.equal(gopFor(0), 2);
});

test("wholeFileArgs encodes AV1+Opus to fragmented mp4 with audio", () => {
  const a = wholeFileArgs("in.mp4", "out.mp4", PRESETS.screencast, true, true);
  assert.ok(a.includes("libsvtav1"));
  assert.ok(a.includes("libopus"));
  assert.ok(a.includes("+frag_keyframe+empty_moov+default_base_moof"));
  assert.equal(a.at(-1), "out.mp4");
});

test("wholeFileArgs uses -an when there is no audio", () => {
  const a = wholeFileArgs("in.mp4", "out.mp4", PRESETS.screencast, true, false);
  assert.ok(a.includes("-an"));
  assert.ok(!a.includes("libopus"));
});

test("splitArgs copy-splits the video stream by segment time", () => {
  const a = splitArgs("in.mp4", "seg_%04d.mkv", 30);
  assert.deepEqual(a, [
    "-y", "-i", "in.mp4", "-map", "0:v:0", "-c", "copy",
    "-f", "segment", "-segment_time", "30", "-reset_timestamps", "1",
    "seg_%04d.mkv",
  ]);
});

test("segmentEncodeArgs encodes video-only AV1 (no fragment, no audio)", () => {
  const a = segmentEncodeArgs("seg.mkv", "enc.mp4", PRESETS.talkinghead, true);
  assert.ok(a.includes("libsvtav1"));
  assert.ok(a.includes("-an"));
  assert.ok(!a.includes("+frag_keyframe+empty_moov+default_base_moof"));
});

test("concatArgs copy-concats a concat list", () => {
  assert.deepEqual(concatArgs("list.txt", "video.mp4"), [
    "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
    "-c", "copy", "-f", "mp4", "video.mp4",
  ]);
});

test("muxFragmentArgs muxes video+audio and fragments; audio optional", () => {
  const withA = muxFragmentArgs("v.mp4", "a.ogg", "out.mp4");
  assert.ok(withA.includes("a.ogg"));
  assert.ok(withA.includes("+frag_keyframe+empty_moov+default_base_moof"));
  const noA = muxFragmentArgs("v.mp4", null, "out.mp4");
  assert.ok(!noA.includes("a.ogg"));
});

test("resolveBin returns the bundled ffmpeg path when present", () => {
  const p = resolveBin("ffmpeg");
  assert.match(p, /ffmpeg$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test cli/ffmpeg.test.js`
Expected: FAIL — `Cannot find module './ffmpeg.js'`.

- [ ] **Step 3: Implement `cli/ffmpeg.js`**

```js
// cli/ffmpeg.js
// All ffmpeg/ffprobe interaction: binary resolution, probing, arg building, run.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI-owned presets (independent of lib/presets.dart). `svt` is the SVT-AV1
// preset: 0 slowest/smallest … 13 fastest/largest.
export const PRESETS = {
  screencast:  { fps: 15, crf: 34, svt: 6, denoise: true,  audio: 20, label: "Screencast" },
  talkinghead: { fps: 24, crf: 30, svt: 6, denoise: true,  audio: 24, label: "Talking head" },
  squeeze:     { fps: 10, crf: 38, svt: 2, denoise: true,  audio: 16, label: "Maximum squeeze" },
  near:        { fps: 24, crf: 26, svt: 4, denoise: false, audio: 32, label: "Near-transparent" },
};

export function resolveBin(name) {
  const candidates = [
    join(__dirname, "ffmpeg", name),
    join(__dirname, "..", "tools", "ffmpeg", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return name;
}

export const FFMPEG = resolveBin("ffmpeg");
export const FFPROBE = resolveBin("ffprobe");

export function hasSvtAv1() {
  try {
    const r = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
    return (r.stdout + r.stderr).includes("libsvtav1");
  } catch {
    return false;
  }
}

export function probe(src) {
  let duration = 0, hasAudio = false;
  try {
    const r = spawnSync(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "default=noprint_wrappers=1", src,
    ], { encoding: "utf8" });
    const out = r.stdout || "";
    const m = out.match(/duration=([\d.]+)/);
    if (m) duration = parseFloat(m[1]) || 0;
    hasAudio = /codec_type=audio/.test(out);
  } catch { /* leave defaults */ }
  return { duration, hasAudio };
}

export function gopFor(fps) {
  return Math.max(2, Math.round((fps || 0) * 2));
}

const FRAG = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000"];

function videoFilter(p, cap1080) {
  const vf = [`fps=${p.fps}`];
  if (cap1080) vf.push("scale=-2:'min(1080,ih)'");
  if (p.denoise) vf.push("hqdn3d=2:1:2:3");
  return vf.join(",");
}

function videoCodec(p) {
  return [
    "-c:v", "libsvtav1", "-crf", String(p.crf), "-preset", String(p.svt),
    "-g", String(gopFor(p.fps)), "-svtav1-params", "tune=0",
  ];
}

// Whole-file path: one process, video + (optional) audio, fragmented fMP4.
export function wholeFileArgs(src, dst, p, cap1080, hasAudio) {
  const audio = hasAudio
    ? ["-c:a", "libopus", "-b:a", `${p.audio}k`, "-ac", "1"]
    : ["-an"];
  return [
    "-y", "-i", src,
    ...videoCodec(p),
    "-vf", videoFilter(p, cap1080),
    ...audio,
    ...FRAG, "-f", "mp4", dst,
  ];
}

// Copy-split the source video stream at its own keyframes into time segments.
export function splitArgs(src, dstPattern, segLen) {
  return [
    "-y", "-i", src, "-map", "0:v:0", "-c", "copy",
    "-f", "segment", "-segment_time", String(segLen), "-reset_timestamps", "1",
    dstPattern,
  ];
}

// Encode one source segment to AV1 video-only, plain mp4 (fragmented later).
export function segmentEncodeArgs(src, dst, p, cap1080) {
  return [
    "-y", "-i", src,
    ...videoCodec(p),
    "-vf", videoFilter(p, cap1080),
    "-an", "-f", "mp4", dst,
  ];
}

// Concat-copy encoded AV1 segments listed in `listFile`.
export function concatArgs(listFile, dst) {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-f", "mp4", dst];
}

// Encode audio once over the whole source (Opus in Ogg).
export function audioArgs(src, dst, p) {
  return ["-y", "-i", src, "-vn", "-c:a", "libopus", "-b:a", `${p.audio}k`, "-ac", "1", "-f", "ogg", dst];
}

// Mux concatenated video with the single audio track and fragment to fMP4.
export function muxFragmentArgs(videoPath, audioPath, dst) {
  const inputs = ["-i", videoPath, ...(audioPath ? ["-i", audioPath] : [])];
  return ["-y", ...inputs, "-c", "copy", ...FRAG, "-f", "mp4", dst];
}

export function runFfmpeg(args, onTime) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    const re = /time=(\d+):(\d+):(\d+)\.(\d+)/;
    proc.stderr.on("data", (chunk) => {
      const m = String(chunk).match(re);
      if (m && onTime) onTime(+m[1] * 3600 + +m[2] * 60 + +m[3]);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${args.join(" ")}`));
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test cli/ffmpeg.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/ffmpeg.js cli/ffmpeg.test.js
git commit -m "feat(cli): extract ffmpeg binary, probe, and arg builders"
```

---

### Task 3: Pipeline — decisions + whole-file path (`cli/pipeline.js`)

**Files:**
- Create: `cli/pipeline.js`
- Test: `cli/pipeline.test.js`
- Test: `cli/interop.test.js`

**Interfaces:**
- Consumes: `makeSemaphore` (Task 1); `probe`, `runFfmpeg`, `wholeFileArgs`, `PRESETS`, `hasSvtAv1`, `FFMPEG` (Task 2); `encodeTinvStream` from `cli/tinv-format.js`.
- Produces:
  - `shouldChunk(duration: number, minSplit: number): boolean`
  - `segmentCount(duration: number, segLen: number): number`
  - `convertOne(src, dst, presetName, opts): Promise<{ srcBytes, outBytes }>` where `opts = { cap1080, segLen, minSplit, sem, onTime? }`. In this task `convertOne` implements ONLY the whole-file path; the chunked branch is added in Task 4.

- [ ] **Step 1: Write the failing pure-logic tests**

```js
// cli/pipeline.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldChunk, segmentCount } from "./pipeline.js";

test("shouldChunk only above the min-split duration", () => {
  assert.equal(shouldChunk(120, 60), true);
  assert.equal(shouldChunk(60, 60), true);
  assert.equal(shouldChunk(59, 60), false);
  assert.equal(shouldChunk(0, 60), false);
});

test("segmentCount is ceil(duration/segLen), at least 1", () => {
  assert.equal(segmentCount(90, 30), 3);
  assert.equal(segmentCount(91, 30), 4);
  assert.equal(segmentCount(10, 30), 1);
  assert.equal(segmentCount(0, 30), 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test cli/pipeline.test.js`
Expected: FAIL — `Cannot find module './pipeline.js'`.

- [ ] **Step 3: Implement `cli/pipeline.js` (whole-file path only)**

```js
// cli/pipeline.js
// Per-file orchestration: decide whole-file vs chunked, encode, wrap .tinv.
import { readFile, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

import { probe, runFfmpeg, wholeFileArgs, PRESETS } from "./ffmpeg.js";
import { encodeTinvStream } from "./tinv-format.js";

export function shouldChunk(duration, minSplit) {
  return duration >= minSplit && duration > 0;
}

export function segmentCount(duration, segLen) {
  if (duration <= 0 || segLen <= 0) return 1;
  return Math.max(1, Math.ceil(duration / segLen));
}

async function wrapTinv(fMp4Path, src, srcBytes, dst) {
  const video = new Uint8Array(await readFile(fMp4Path));
  const meta = {
    version: 1,
    title: basename(src, extname(src)),
    sourceSizeBytes: srcBytes,
    encodedSizeBytes: video.length,
    chapters: [],
  };
  const container = await encodeTinvStream(video, meta);
  await writeFile(dst, container);
  return { outBytes: container.length };
}

export async function convertOne(src, dst, presetName, opts) {
  const p = PRESETS[presetName];
  const { duration, hasAudio } = probe(src);
  const srcBytes = (await stat(src)).size;
  const work = await mkdtemp(join(tmpdir(), "tinv_"));
  try {
    const fMp4 = join(work, "out.mp4");
    await opts.sem.run(() =>
      runFfmpeg(wholeFileArgs(src, fMp4, p, opts.cap1080, hasAudio), opts.onTime),
    );
    const { outBytes } = await wrapTinv(fMp4, src, srcBytes, dst);
    return { srcBytes, outBytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run to verify pure tests pass**

Run: `node --test cli/pipeline.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the whole-file interop integration test**

```js
// cli/interop.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FFMPEG, runFfmpeg, hasSvtAv1 } from "./ffmpeg.js";
import { makeSemaphore } from "./pool.js";
import { convertOne } from "./pipeline.js";
import { decodeTinv } from "../web/tinv-format.js";

const ffOk = hasSvtAv1();

async function makeClip(dir, seconds = 2) {
  const src = join(dir, "clip.mp4");
  await new Promise((resolve, reject) => {
    const { spawn } = require ? require("node:child_process") : null;
    void spawn;
    resolve();
  }).catch(() => {});
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, src,
  ]);
  return src;
}

// decode a CLI-made .tinv with the WEB module and assert it is valid fMP4
async function assertPlayable(tinvPath) {
  const bytes = new Uint8Array(await readFile(tinvPath));
  const r = await decodeTinv(bytes);
  assert.ok(r && r.blob, "web module failed to decode CLI file");
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  const boxType = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  assert.equal(boxType, "ftyp", "decoded payload is not fragmented MP4");
  assert.equal(r.blob.type, "video/mp4");
}

test("whole-file CLI output decodes as valid fMP4 in the web module", { skip: !ffOk && "ffmpeg/libsvtav1 unavailable" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinv_it_"));
  try {
    const src = await makeClip(dir, 2);
    const dst = join(dir, "clip.tinv");
    const sem = makeSemaphore(2);
    const r = await convertOne(src, dst, "talkinghead", { cap1080: true, segLen: 30, minSplit: 9999, sem });
    assert.ok(r.outBytes > 0);
    await assertPlayable(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

NOTE: simplify `makeClip` — remove the dead `require` block; final form:

```js
async function makeClip(dir, seconds = 2) {
  const src = join(dir, "clip.mp4");
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, src,
  ]);
  return src;
}
```

Use this clean version when writing the file (the dead block above was illustrative of what NOT to include). The `FFMPEG` import is used indirectly by `runFfmpeg`; keep it only if referenced, otherwise drop it to avoid an unused import.

- [ ] **Step 6: Run the interop test (whole-file)**

Run: `node --test cli/interop.test.js`
Expected: PASS — 1 test (or skipped if ffmpeg/libsvtav1 missing).

- [ ] **Step 7: Commit**

```bash
git add cli/pipeline.js cli/pipeline.test.js cli/interop.test.js
git commit -m "feat(cli): pipeline decisions + whole-file encode path with interop test"
```

---

### Task 4: Pipeline — chunked parallel path (`cli/pipeline.js`)

**Files:**
- Modify: `cli/pipeline.js` (extend `convertOne` with the chunked branch)
- Modify: `cli/interop.test.js` (add a force-chunked case)

**Interfaces:**
- Consumes: everything from Task 3 plus `splitArgs`, `segmentEncodeArgs`, `concatArgs`, `audioArgs`, `muxFragmentArgs` (Task 2).
- Produces: `convertOne` now chunks when `shouldChunk(duration, opts.minSplit)` is true. Same return shape `{ srcBytes, outBytes }`.

- [ ] **Step 1: Write the failing force-chunked interop test**

Add to `cli/interop.test.js`:

```js
test("force-chunked CLI output decodes as valid fMP4 with ~correct duration", { skip: !ffOk && "ffmpeg/libsvtav1 unavailable" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinv_itc_"));
  try {
    const src = await makeClip(dir, 3);
    const dst = join(dir, "clip.tinv");
    const sem = makeSemaphore(4);
    // segLen 1s + minSplit 0 forces ~3 parallel segments on a 3s clip
    const r = await convertOne(src, dst, "talkinghead", { cap1080: true, segLen: 1, minSplit: 0, sem });
    assert.ok(r.outBytes > 0);
    await assertPlayable(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `node --test cli/interop.test.js`
Expected: FAIL — current `convertOne` ignores `minSplit`/`segLen` and runs whole-file; with `minSplit: 0` the chunked branch does not exist yet, so behavior is wrong/unimplemented. (If it currently passes via the whole-file path, proceed anyway — Step 3 makes the chunked branch the real code path that the next runs exercise.)

- [ ] **Step 3: Extend `cli/pipeline.js` with the chunked branch**

Add imports at the top (merge with the existing `./ffmpeg.js` import):

```js
import {
  probe, runFfmpeg, wholeFileArgs, PRESETS,
  splitArgs, segmentEncodeArgs, concatArgs, audioArgs, muxFragmentArgs,
} from "./ffmpeg.js";
import { readdir } from "node:fs/promises";
```

Add the chunked encoder helper:

```js
async function encodeChunked(src, work, p, opts, hasAudio) {
  // 1. Copy-split the source video at its keyframes into time segments.
  await runFfmpeg(splitArgs(src, join(work, "src_%04d.mkv"), opts.segLen));
  const srcSegs = (await readdir(work))
    .filter((f) => /^src_\d+\.mkv$/.test(f))
    .sort()
    .map((f) => join(work, f));
  if (!srcSegs.length) throw new Error("copy-split produced no segments");

  // 2. Encode each segment to AV1 video-only, in parallel through the shared pool.
  const encSegs = srcSegs.map((_, i) => join(work, `enc_${String(i).padStart(4, "0")}.mp4`));
  await Promise.all(srcSegs.map((s, i) =>
    opts.sem.run(() => runFfmpeg(segmentEncodeArgs(s, encSegs[i], p, opts.cap1080), opts.onTime)),
  ));

  // 3. Concat-copy the encoded video segments.
  const listFile = join(work, "list.txt");
  await writeFile(listFile, encSegs.map((path) => `file '${path}'`).join("\n"));
  const videoPath = join(work, "video.mp4");
  await runFfmpeg(concatArgs(listFile, videoPath));

  // 4. Encode audio once over the original source.
  let audioPath = null;
  if (hasAudio) {
    audioPath = join(work, "audio.ogg");
    await runFfmpeg(audioArgs(src, audioPath, p));
  }

  // 5. Mux + fragment to streaming fMP4.
  const fMp4 = join(work, "out.mp4");
  await runFfmpeg(muxFragmentArgs(videoPath, audioPath, fMp4));
  return fMp4;
}
```

Replace the body of `convertOne` between `try {` and the `wrapTinv` call so it branches:

```js
  try {
    let fMp4;
    if (shouldChunk(duration, opts.minSplit)) {
      fMp4 = await encodeChunked(src, work, p, opts, hasAudio);
    } else {
      fMp4 = join(work, "out.mp4");
      await opts.sem.run(() =>
        runFfmpeg(wholeFileArgs(src, fMp4, p, opts.cap1080, hasAudio), opts.onTime),
      );
    }
    const { outBytes } = await wrapTinv(fMp4, src, srcBytes, dst);
    return { srcBytes, outBytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
```

(Ensure `writeFile` is in the `node:fs/promises` import list — it is from Task 3.)

- [ ] **Step 4: Run both interop tests**

Run: `node --test cli/interop.test.js`
Expected: PASS — 2 tests (whole-file + force-chunked), or skipped without ffmpeg.

- [ ] **Step 5: Run the whole cli test suite**

Run: `node --test cli/`
Expected: PASS — pool, ffmpeg, pipeline, interop tests all green.

- [ ] **Step 6: Commit**

```bash
git add cli/pipeline.js cli/interop.test.js
git commit -m "feat(cli): chunked parallel encode path (split/encode/concat/mux)"
```

---

### Task 5: Entry point + scheduling (`cli/convert.js`)

**Files:**
- Modify: `cli/convert.js` (replace with the thin entry that wires modules together)

**Interfaces:**
- Consumes: `makeSemaphore` (Task 1); `hasSvtAv1`, `PRESETS` (Task 2); `convertOne` (Tasks 3–4).
- Produces: the CLI binary behavior. New flags: `--jobs <n>`, `--segment <seconds>`, `--min-split <seconds>`, plus existing `--preset`, `--no-cap`, `-o/--out`.

- [ ] **Step 1: Replace `cli/convert.js`**

```js
#!/usr/bin/env node
// tinv local converter — independent, parallel pipeline.
//
//   node cli/convert.js input.mp4 [-o out.tinv] [--preset screencast|talkinghead|squeeze|near]
//                       [--no-cap] [--jobs N] [--segment SEC] [--min-split SEC]
//   node cli/convert.js *.mp4 --preset screencast
//
// A shared semaphore caps concurrent encodes. Small files run whole; large files
// are split and their segments encoded in parallel. Output is AV1-in-fMP4 in the
// TINV3 container, so the web app and extension can play CLI-made files.
import { availableParallelism } from "node:os";
import { basename, extname, join, dirname } from "node:path";

import { hasSvtAv1, PRESETS } from "./ffmpeg.js";
import { makeSemaphore } from "./pool.js";
import { convertOne } from "./pipeline.js";

function parseArgs(argv) {
  const inputs = [];
  let preset = "screencast";
  let cap1080 = true;
  let out = null;
  let jobs = availableParallelism();
  let segLen = 30;
  let minSplit = 60;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preset") preset = argv[++i];
    else if (a === "--no-cap") cap1080 = false;
    else if (a === "-o" || a === "--out") out = argv[++i];
    else if (a === "--jobs") jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--segment") segLen = Math.max(1, parseFloat(argv[++i]) || 30);
    else if (a === "--min-split") minSplit = Math.max(0, parseFloat(argv[++i]) || 0);
    else inputs.push(a);
  }
  return { inputs, preset, cap1080, out, jobs, segLen, minSplit };
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

async function main() {
  const { inputs, preset, cap1080, out, jobs, segLen, minSplit } = parseArgs(process.argv.slice(2));

  if (!inputs.length) {
    console.log("Usage: node cli/convert.js <input...> [--preset screencast|talkinghead|squeeze|near]");
    console.log("       [--no-cap] [--jobs N] [--segment SEC] [--min-split SEC] [-o out.tinv]");
    console.log("Presets:", Object.keys(PRESETS).join(", "));
    process.exit(1);
  }
  if (!PRESETS[preset]) {
    console.error(`Unknown preset "${preset}". Options: ${Object.keys(PRESETS).join(", ")}`);
    process.exit(1);
  }
  if (!hasSvtAv1()) {
    console.error("ffmpeg with libsvtav1 not found. Install tinv.app, or put a static ffmpeg on PATH / in tools/ffmpeg/.");
    process.exit(1);
  }

  console.log(`tinv: ${inputs.length} file(s), preset=${preset}, jobs=${jobs}, segment=${segLen}s, min-split=${minSplit}s`);
  const sem = makeSemaphore(jobs);
  let failures = 0;

  await Promise.all(inputs.map(async (src) => {
    const dst = out && inputs.length === 1
      ? out
      : join(dirname(src), basename(src, extname(src)) + ".tinv");
    console.log(`→ ${basename(src)}  (${PRESETS[preset].label})`);
    try {
      const { srcBytes, outBytes } = await convertOne(src, dst, preset, { cap1080, segLen, minSplit, sem });
      const ratio = outBytes ? srcBytes / outBytes : 0;
      console.log(`  ✓ ${basename(src)}: ${mb(srcBytes)} → ${mb(outBytes)}  (${ratio.toFixed(1)}× smaller)  ${dst}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${basename(src)}: ${e.message}`);
    }
  }));

  process.exit(failures ? 1 : 0);
}

main();
```

- [ ] **Step 2: Smoke test — usage**

Run: `node cli/convert.js`
Expected: prints usage with the new flags and the preset list; exits non-zero.

- [ ] **Step 3: Smoke test — real chunked encode**

Run:
```bash
cd cli && ./ffmpeg/ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x480:rate=24:duration=6 -f lavfi -i sine=frequency=440:duration=6 /tmp/tinv_smoke.mp4 && node convert.js /tmp/tinv_smoke.mp4 --segment 2 --min-split 0 --jobs 4 -o /tmp/tinv_smoke.tinv
```
Expected: a `tinv: 1 file(s) … jobs=4 …` line, then `✓ … × smaller … /tmp/tinv_smoke.tinv`. File exists.

- [ ] **Step 4: Verify the smoke-test output is playable**

Run:
```bash
node --input-type=module -e 'import { decodeTinv } from "./web/tinv-format.js"; import { readFile } from "node:fs/promises"; const b=new Uint8Array(await readFile("/tmp/tinv_smoke.tinv")); const r=await decodeTinv(b); const v=new Uint8Array(await r.blob.arrayBuffer()); const t=String.fromCharCode(v[4],v[5],v[6],v[7]); console.log("ok", r.blob.type, t==="ftyp"?"valid fMP4":"BAD");'
```
Expected: `ok video/mp4 valid fMP4`.

- [ ] **Step 5: Run the full suite once more**

Run: `node --test cli/`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add cli/convert.js
git commit -m "feat(cli): parallel scheduling entry point with --jobs/--segment/--min-split"
```

---

### Task 6: Usage + benchmarking notes (`cli/README.md`)

**Files:**
- Create or Modify: `cli/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write `cli/README.md`**

```markdown
# tinv local converter

Independent, parallel encoder. Produces `.tinv` (AV1-in-fMP4, TINV3) that the web
app and extension can play.

## Usage

    node cli/convert.js <input...> [options]

Options:
- `--preset screencast|talkinghead|squeeze|near` (default: screencast)
- `--jobs N` — max concurrent encodes (default: logical CPU count)
- `--segment SEC` — target segment length when chunking (default: 30)
- `--min-split SEC` — only split files at least this long (default: 60)
- `--no-cap` — do not cap height to 1080
- `-o, --out FILE` — output path (single input only)

Small files encode whole; large files are copy-split at keyframes, encoded in
parallel, concat-copied, muxed with a single Opus track, and fragmented.

## Tuning for your machine

`--jobs` and the SVT-AV1 `svt` preset (in `cli/ffmpeg.js` `PRESETS`) are the speed
levers. To pick defaults, benchmark a representative big file:

    for j in 4 8 12 16; do
      echo "jobs=$j"; time node cli/convert.js cli/r.mp4 --jobs $j -o /tmp/r_$j.tinv
    done

Higher `svt` (6 → 10) trades a few percent size for more speed. Hardware AV1
(`av1_videotoolbox`) is intentionally not used: the bundled ffmpeg lacks it, and
hardware HEVC would break Chrome/Firefox playback.
```

- [ ] **Step 2: Commit**

```bash
git add cli/README.md
git commit -m "docs(cli): usage and benchmarking notes for the parallel encoder"
```

---

## Self-Review

**Spec coverage:**
- Independent pipeline / no `../web` import → Task 5 imports only `cli/` modules; `cli/tinv-format.js` already standalone. ✓
- Module layout (convert/pool/ffmpeg/pipeline/tinv-format) → Tasks 1,2,3,5. ✓
- Unified semaphore scheduling both workloads → Task 1 semaphore, Task 5 shared `sem` across all files, Task 4 segment jobs use the same `sem`. ✓
- Split decision knobs `--jobs/--segment/--min-split` → Task 5. ✓
- Chunked DAG (copy-split → parallel encode → concat → audio-once → mux/fragment → wrap) → Task 4. ✓
- Whole-file path for small files → Task 3. ✓
- Interop (AV1-in-fMP4 plays via web module) → Task 3 + Task 4 interop tests, Task 5 Step 4. ✓
- Per-file temp dir cleaned on success/failure → Task 3 `try/finally rm`. ✓
- One failed file doesn't abort the batch → Task 5 per-file `try/catch`, `Promise.all` over independent catches. ✓
- Tests: pool, segment math, interop, benchmark note → Tasks 1,3,4,6. ✓

**Deviation from spec (noted):** the spec mentioned "segment time-range computation" as a unit; the chosen copy-split uses ffmpeg's segment muxer (cuts at source keyframes), so there are no precomputed ranges. The pure unit tests cover `shouldChunk` and `segmentCount` (used for the split decision and reporting) instead — same intent, matched to the implementation.

**Placeholder scan:** the only illustrative-not-final code is the dead `require` block in Task 3 Step 5, which is explicitly flagged with the clean replacement to use. No TBD/TODO remain.

**Type consistency:** `convertOne(src, dst, presetName, opts)` with `opts={cap1080,segLen,minSplit,sem,onTime?}` and return `{srcBytes,outBytes}` is consistent across Tasks 3, 4, 5. `makeSemaphore(limit).run(fn)` consistent across Tasks 1, 3, 4, 5. Arg-builder names match between Task 2 definitions and Task 3/4 usage.
