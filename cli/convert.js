#!/usr/bin/env node
// tinv converter — native CLI. Replaces the Flutter encoder.
//
// Wraps a bundled (or PATH) ffmpeg with SVT-AV1 to make tiny AV1/Opus video,
// then wraps it into the obfuscated .tinv container (embedded metadata + XOR),
// using the SAME format code as the players (../web/tinv-format.js).
//
//   node cli/convert.js input.mp4 [output.tinv] [--preset screencast|talkinghead|squeeze|near] [--no-cap]
//
// For batches:
//   node cli/convert.js *.mp4 --preset screencast

import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { encodeTinvStream } from "../web/tinv-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- ffmpeg recipes (mirror lib/presets.dart) ----

const PRESETS = {
  screencast:  { fps: 15, crf: 34, svt: 4, denoise: true,  audio: 20, label: "Screencast" },
  talkinghead: { fps: 24, crf: 30, svt: 4, denoise: true,  audio: 24, label: "Talking head" },
  squeeze:     { fps: 10, crf: 38, svt: 2, denoise: true,  audio: 16, label: "Maximum squeeze" },
  near:        { fps: 24, crf: 26, svt: 4, denoise: false, audio: 32, label: "Near-transparent" },
};

function ffmpegArgs(src, dst, p, cap1080) {
  const vf = [`fps=${p.fps}`];
  if (cap1080) vf.push("scale=-2:'min(1080,ih)'");
  if (p.denoise) vf.push("hqdn3d=2:1:2:3");
  // Keyframe every ~2s so the fragmented MP4 splits into small, independently
  // decodable streaming fragments (TINV3) — the player starts before the whole
  // file downloads. A 2s GOP costs a few percent vs. a long GOP, a fair trade.
  // Output is fragmented MP4 (moof per keyframe): MediaSource accepts AV1-in-MP4
  // reliably, unlike AV1-in-WebM.
  const gop = Math.max(2, Math.round(p.fps * 2));
  return [
    "-y", "-i", src,
    "-c:v", "libsvtav1", "-crf", String(p.crf), "-preset", String(p.svt),
    "-g", String(gop), "-svtav1-params", "tune=0",
    "-vf", vf.join(","),
    "-c:a", "libopus", "-b:a", `${p.audio}k`, "-ac", "1",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "2000000",
    "-f", "mp4", dst,
  ];
}

// ---- locate ffmpeg/ffprobe (bundled app first, then PATH) ----

function resolveBin(name) {
  const candidates = [
    join(__dirname, "ffmpeg", name),          // bundled with the CLI
    join(__dirname, "..", "tools", "ffmpeg", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return name; // fall back to PATH
}

const FFMPEG = resolveBin("ffmpeg");
const FFPROBE = resolveBin("ffprobe");

function hasSvtAv1() {
  try {
    const r = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
    return (r.stdout + r.stderr).includes("libsvtav1");
  } catch {
    return false;
  }
}

function probeDuration(src) {
  try {
    const r = spawnSync(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", src,
    ], { encoding: "utf8" });
    return parseFloat(r.stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

// ---- one encode ----

function runFfmpeg(src, tmpWebm, preset, cap1080, durationSec) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ffmpegArgs(src, tmpWebm, preset, cap1080));
    const timeRe = /time=(\d+):(\d+):(\d+)\.(\d+)/;
    let lastPct = -1;
    proc.stderr.on("data", (chunk) => {
      const m = String(chunk).match(timeRe);
      if (m && durationSec > 0) {
        const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
        const pct = Math.min(100, Math.round((secs / durationSec) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  encoding… ${pct}%   `);
        }
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      process.stdout.write("\r");
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function convertOne(src, dst, preset, cap1080) {
  if (!existsSync(src)) throw new Error(`not found: ${src}`);
  const srcBytes = (await readFile(src)).length;
  const durationSec = probeDuration(src);
  const tmpOut = join(tmpdir(), `tinv_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

  console.log(`→ ${basename(src)}  (${PRESETS[preset] ? PRESETS[preset].label : preset})`);
  await runFfmpeg(src, tmpOut, PRESETS[preset], cap1080, durationSec);

  const video = new Uint8Array(await readFile(tmpOut));
  const meta = {
    version: 1,
    title: basename(src, extname(src)),
    sourceSizeBytes: srcBytes,
    encodedSizeBytes: video.length,
    chapters: [],
  };
  const container = await encodeTinvStream(video, meta);
  await writeFile(dst, container);
  await unlink(tmpOut).catch(() => {});
  const webm = video; // (name kept for the size log below)

  const ratio = webm.length ? (srcBytes / webm.length) : 0;
  const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
  console.log(`  ✓ ${mb(srcBytes)} → ${mb(container.length)}  (${ratio.toFixed(1)}× smaller)  ${dst}`);
}

// ---- CLI ----

function parseArgs(argv) {
  const inputs = [];
  let preset = "screencast";
  let cap1080 = true;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preset") preset = argv[++i];
    else if (a === "--no-cap") cap1080 = false;
    else if (a === "-o" || a === "--out") out = argv[++i];
    else inputs.push(a);
  }
  return { inputs, preset, cap1080, out };
}

async function main() {
  const { inputs, preset, cap1080, out } = parseArgs(process.argv.slice(2));

  if (!inputs.length) {
    console.log("Usage: node cli/convert.js <input...> [--preset screencast|talkinghead|squeeze|near] [--no-cap] [-o out.tinv]");
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

  let failures = 0;
  for (const src of inputs) {
    const dst = out && inputs.length === 1
      ? out
      : join(dirname(src), basename(src, extname(src)) + ".tinv");
    try {
      await convertOne(src, dst, preset, cap1080);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${basename(src)}: ${e.message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
