// cli/pipeline.js
// Per-file orchestration: decide whole-file vs chunked, encode, wrap .tinv.
import { readFile, writeFile, stat, mkdtemp, rm, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  probe, runFfmpeg, wholeFileArgs, PRESETS,
  splitArgs, segmentEncodeArgs, concatArgs, audioArgs, muxFragmentArgs,
} from "./ffmpeg.js";
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

async function encodeChunked(src, work, p, opts, hasAudio, report) {
  // 1. Copy-split the source video at its keyframes into time segments.
  await runFfmpeg(splitArgs(src, join(work, "src_%04d.mkv"), opts.segLen));
  const srcSegs = (await readdir(work))
    .filter((f) => /^src_\d+\.mkv$/.test(f))
    .sort()
    .map((f) => join(work, f));
  if (!srcSegs.length) throw new Error("copy-split produced no segments");

  const total = srcSegs.length;
  report({ phase: "split", total });

  // 2. Encode each segment to AV1 video-only, in parallel through the shared
  //    pool, reporting each completion so a long run is visibly making progress.
  const encSegs = srcSegs.map((_, i) => join(work, `enc_${String(i).padStart(4, "0")}.mp4`));
  const ac = new AbortController();
  let done = 0;
  try {
    await Promise.all(srcSegs.map((s, i) =>
      opts.sem.run(async () => {
        await runFfmpeg(segmentEncodeArgs(s, encSegs[i], p, opts.cap1080, opts.lp), { signal: ac.signal });
        report({ phase: "segment", done: ++done, total });
      })));
  } catch (e) {
    ac.abort();
    throw e;
  }

  // 3. Concat-copy the encoded video segments.
  report({ phase: "concat", total });
  const listFile = join(work, "list.txt");
  await writeFile(listFile, encSegs.map((path) => `file '${path}'`).join("\n"));
  const videoPath = join(work, "video.mp4");
  await runFfmpeg(concatArgs(listFile, videoPath));

  // 4. Encode audio once over the original source.
  let audioPath = null;
  if (hasAudio) {
    report({ phase: "audio", total });
    audioPath = join(work, "audio.ogg");
    await runFfmpeg(audioArgs(src, audioPath, p));
  }

  // 5. Mux + fragment to streaming fMP4.
  report({ phase: "mux", total });
  const fMp4 = join(work, "out.mp4");
  await runFfmpeg(muxFragmentArgs(videoPath, audioPath, fMp4));
  return fMp4;
}

export async function convertOne(src, dst, presetName, opts) {
  const p = PRESETS[presetName];
  const { duration, hasAudio } = probe(src);
  const srcBytes = (await stat(src)).size;
  const report = opts.onProgress || (() => {});
  const work = await mkdtemp(join(tmpdir(), "tinv_"));
  try {
    let fMp4;
    if (shouldChunk(duration, opts.minSplit)) {
      fMp4 = await encodeChunked(src, work, p, opts, hasAudio, report);
    } else {
      report({ phase: "whole" });
      fMp4 = join(work, "out.mp4");
      await opts.sem.run(() =>
        runFfmpeg(wholeFileArgs(src, fMp4, p, opts.cap1080, hasAudio)),
      );
    }
    const { outBytes } = await wrapTinv(fMp4, src, srcBytes, dst);
    return { srcBytes, outBytes };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
