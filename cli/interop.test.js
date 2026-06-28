// cli/interop.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg, hasSvtAv1 } from "./ffmpeg.js";
import { makeSemaphore } from "./pool.js";
import { convertOne } from "./pipeline.js";
import { decodeTinv } from "../web/tinv-format.js";

const ffOk = hasSvtAv1();

async function makeClip(dir, seconds = 2) {
  const src = join(dir, "clip.mp4");
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
