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

test("segmentEncodeArgs bounds SVT-AV1 threads via lp when given", () => {
  const a = segmentEncodeArgs("seg.mkv", "enc.mp4", PRESETS.talkinghead, true, 4);
  const params = a.at(a.indexOf("-svtav1-params") + 1);
  assert.match(params, /(^|:)lp=4(:|$)/);
});

test("wholeFileArgs leaves SVT-AV1 thread count on auto (no lp)", () => {
  const a = wholeFileArgs("in.mp4", "out.mp4", PRESETS.screencast, true, false);
  const params = a.at(a.indexOf("-svtav1-params") + 1);
  assert.ok(!/lp=/.test(params), `whole-file encode should not pin lp, got "${params}"`);
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
