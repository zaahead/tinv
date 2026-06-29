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
import { makeSemaphore, defaultJobs, lpFor } from "./pool.js";
import { convertOne } from "./pipeline.js";

function parseArgs(argv) {
  const inputs = [];
  let preset = "screencast";
  let cap1080 = true;
  let out = null;
  let jobs = defaultJobs(availableParallelism());
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

// Per-file progress renderer. For a single file on a TTY, update one line in
// place; otherwise print milestone lines (so piped/multi-file output stays sane).
function makeReporter(name, inline) {
  return (ev) => {
    switch (ev.phase) {
      case "whole":
        console.log(`  ${name}: encoding…`);
        break;
      case "split":
        console.log(`  ${name}: split into ${ev.total} segments`);
        break;
      case "segment":
        if (inline) {
          process.stdout.write(`\r  ${name}: encoded ${ev.done}/${ev.total} segments`);
          if (ev.done === ev.total) process.stdout.write("\n");
        } else {
          console.log(`  ${name}: encoded ${ev.done}/${ev.total} segments`);
        }
        break;
      case "concat":
        console.log(`  ${name}: concatenating + muxing…`);
        break;
    }
  };
}

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

  const lp = lpFor(availableParallelism(), jobs);
  console.log(`tinv: ${inputs.length} file(s), preset=${preset}, jobs=${jobs}, lp=${lp}, segment=${segLen}s, min-split=${minSplit}s`);
  const sem = makeSemaphore(jobs);
  const inline = inputs.length === 1 && process.stdout.isTTY;
  let failures = 0;

  await Promise.all(inputs.map(async (src) => {
    const dst = out && inputs.length === 1
      ? out
      : join(dirname(src), basename(src, extname(src)) + ".tinv");
    console.log(`→ ${basename(src)}  (${PRESETS[preset].label})`);
    try {
      const onProgress = makeReporter(basename(src), inline);
      const { srcBytes, outBytes } = await convertOne(src, dst, preset, { cap1080, segLen, minSplit, sem, lp, onProgress });
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
