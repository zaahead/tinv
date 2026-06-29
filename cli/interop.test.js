// cli/interop.test.js
// Proves the Rust `tinv` binary produces wire-compatible TINV3: encode a clip
// with the built binary, then decode it with the WEB module and assert it is
// valid fragmented MP4 (i.e. it will play in the web app / extension).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runFfmpeg, hasSvtAv1, FFMPEG, FFPROBE } from "./test-support.mjs";
import { decodeTinv } from "../web/tinv-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "target", "release", "tinv");

const ffOk = hasSvtAv1();
const binOk = await access(BIN).then(() => true).catch(() => false);
const skip = !ffOk ? "ffmpeg/libsvtav1 unavailable" : !binOk ? "tinv binary not built" : false;

async function makeClip(dir, seconds) {
  const src = join(dir, "clip.mp4");
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, src,
  ]);
  return src;
}

function runCli(args) {
  // Point the binary at the same bundled ffmpeg the test uses.
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { ...process.env, TINV_FFMPEG: FFMPEG, TINV_FFPROBE: FFPROBE },
  });
  assert.equal(r.status, 0, `tinv failed: ${r.stderr || r.stdout}`);
  return r;
}

async function assertPlayable(tinvPath) {
  const bytes = new Uint8Array(await readFile(tinvPath));
  const r = await decodeTinv(bytes);
  assert.ok(r && r.blob, "web module failed to decode tinv file");
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  const boxType = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  assert.equal(boxType, "ftyp", "decoded payload is not fragmented MP4");
  assert.equal(r.blob.type, "video/mp4");
}

test("whole-file output decodes as valid fMP4 in the web module", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinv_it_"));
  try {
    const src = await makeClip(dir, 2);
    const dst = join(dir, "clip.tinv");
    runCli([src, "--preset", "talkinghead", "--min-split", "9999", "-o", dst]);
    await assertPlayable(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force-chunked output decodes as valid fMP4 in the web module", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinv_itc_"));
  try {
    const src = await makeClip(dir, 3);
    const dst = join(dir, "clip.tinv");
    // segment 1s + min-split 0 forces parallel segments on a 3s clip
    runCli([src, "--preset", "talkinghead", "--segment", "1", "--min-split", "0", "-o", dst]);
    await assertPlayable(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
