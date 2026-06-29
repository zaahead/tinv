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

// `lp` (SVT-AV1 level-of-parallelism) bounds the encoder's thread count so that
// parallel segment encodes don't each grab every core. Omit it (0/undefined) on
// the whole-file path, where a single encode should use the whole machine.
function videoCodec(p, lp) {
  const params = ["tune=0"];
  if (lp > 0) params.push(`lp=${lp}`);
  return [
    "-c:v", "libsvtav1", "-crf", String(p.crf), "-preset", String(p.svt),
    "-g", String(gopFor(p.fps)), "-svtav1-params", params.join(":"),
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
// `lp` caps this encode's threads so N parallel segments share the cores.
export function segmentEncodeArgs(src, dst, p, cap1080, lp) {
  return [
    "-y", "-i", src,
    ...videoCodec(p, lp),
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

export function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    let aborted = false;
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        proc.kill("SIGTERM");
      } else {
        signal.addEventListener("abort", () => { aborted = true; proc.kill("SIGTERM"); }, { once: true });
      }
    }
    // Keep a rolling tail of stderr so a failure is diagnosable instead of
    // silent. ffmpeg writes progress + errors here; we surface it only on error.
    let tail = "";
    proc.stderr.on("data", (d) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve();
      if (aborted) return reject(new Error("ffmpeg aborted"));
      const last = tail.trim().split("\n").slice(-3).join(" | ");
      reject(new Error(`ffmpeg exited ${code}: ${last || args.join(" ")}`));
    });
  });
}
