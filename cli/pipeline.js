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
