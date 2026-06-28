// In-browser converter — uses the browser's NATIVE WebCodecs AV1 + Opus
// encoders (hardware-accelerated where available, no wasm download), then muxes
// to WebM and wraps into the obfuscated .tinv container.
//
// Chromium only: AV1 encoding via WebCodecs is currently Chromium-only.
// The UI gates Convert to supported browsers (see isConvertSupported).

import { encodeTinvStream } from "./tinv-format.js";
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.js";

export const PRESETS = {
  screencast:  { fps: 15, bitrate: 700_000,  label: "Screen recording" },
  talkinghead: { fps: 24, bitrate: 1_200_000, label: "Camera / motion" },
  squeeze:     { fps: 10, bitrate: 400_000,  label: "Smallest" },
  near:        { fps: 24, bitrate: 2_500_000, label: "Higher quality" },
};

/** Quick capability check used to gate the Convert UI. */
export async function isConvertSupported() {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return { ok: false, reason: "no-webcodecs" };
  }
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    return { ok: false, reason: "no-rvfc" };
  }
  try {
    const v = await VideoEncoder.isConfigSupported({
      codec: "av01.0.04M.08", width: 640, height: 480, bitrate: 800_000, framerate: 15,
    });
    if (!v.supported) return { ok: false, reason: "no-av1" };
  } catch {
    return { ok: false, reason: "no-av1" };
  }
  return { ok: true };
}

// Pick an AV1 codec string + level for the target resolution.
function av1Codec(width, height) {
  // av01.<profile>.<level><tier>.<depth>; level scales with resolution.
  const px = width * height;
  let level = "04"; // ~720p
  if (px > 1280 * 720) level = "08"; // up to 1080p
  if (px > 1920 * 1080) level = "12";
  return `av01.0.${level}M.08`;
}

/**
 * Convert a File to a .tinv (Uint8Array) using native WebCodecs.
 * opts: { preset, cap1080, onProgress(0..1), onStage(text) }
 */
export async function convertFileToTinv(file, opts = {}) {
  const preset = PRESETS[opts.preset] || PRESETS.screencast;
  const cap1080 = opts.cap1080 !== false;
  const stage = opts.onStage || (() => {});
  const progress = opts.onProgress || (() => {});

  stage("Reading video…");
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  await once(video, "loadedmetadata");

  const srcW = video.videoWidth, srcH = video.videoHeight;
  const duration = video.duration;
  if (!srcW || !srcH || !isFinite(duration)) {
    URL.revokeObjectURL(url);
    throw new Error("Could not read the video (unsupported format?).");
  }

  // Target dimensions (cap to 1080p, keep aspect, even numbers).
  let outW = srcW, outH = srcH;
  if (cap1080 && srcH > 1080) {
    outH = 1080;
    outW = Math.round((srcW * 1080) / srcH);
  }
  outW -= outW % 2; outH -= outH % 2;

  // ---- Audio: decode whole track, encode to Opus ----
  let audioChunks = null;
  let audioConfig = null;
  try {
    stage("Encoding audio…");
    const res = await encodeAudio(file);
    audioChunks = res.chunks;
    audioConfig = res.config;
  } catch {
    audioChunks = null; // video-only is fine
  }

  // ---- Muxer (fragmented MP4 so the .tinv streams; see tinv-format.js) ----
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "av1", width: outW, height: outH, frameRate: preset.fps },
    ...(audioChunks ? { audio: { codec: "opus", sampleRate: 48000, numberOfChannels: 1 } } : {}),
    fastStart: "fragmented",
    firstTimestampBehavior: "offset",
  });
  if (audioChunks) for (const c of audioChunks) muxer.addAudioChunk(c.chunk, c.meta);

  // ---- Video: grab frames, encode AV1 ----
  stage("Encoding video…");
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });
  encoder.configure({
    codec: av1Codec(outW, outH),
    width: outW, height: outH,
    bitrate: preset.bitrate,
    framerate: preset.fps,
    latencyMode: "quality",
  });

  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false });

  const frameInterval = 1 / preset.fps;
  const totalFrames = Math.max(1, Math.floor(duration * preset.fps));
  let encoded = 0;

  // Keyframe every ~2s so the muxer emits small, streamable clusters (TINV3),
  // matching the CLI. Lets the player start before the whole file downloads.
  const keyEvery = Math.max(1, Math.round(preset.fps * 2));

  // Seek-and-grab loop: deterministic, works without realtime playback.
  for (let i = 0; i < totalFrames; i++) {
    const t = Math.min(duration - 0.001, i * frameInterval);
    await seek(video, t);
    ctx.drawImage(video, 0, 0, outW, outH);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1_000_000) });
    encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    encoded++;
    if (encoded % 3 === 0) { progress((i / totalFrames) * 0.95); await encoder.flush().catch(()=>{}); }
  }

  stage("Finalizing…");
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  const outBytes = new Uint8Array(muxer.target.buffer);
  URL.revokeObjectURL(url);
  progress(0.98);

  // ---- Wrap into .tinv ----
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const meta = {
    version: 1,
    title: baseName,
    sourceSizeBytes: file.size,
    encodedSizeBytes: outBytes.length,
    chapters: [],
  };
  const tinv = await encodeTinvStream(outBytes, meta);
  progress(1);
  return { bytes: tinv, name: `${baseName}.tinv`, meta };
}

// ---- helpers ----

function once(el, ev) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const fail = () => { cleanup(); rej(new Error("Could not read the video.")); };
    const cleanup = () => {
      el.removeEventListener(ev, ok);
      el.removeEventListener("error", fail);
    };
    el.addEventListener(ev, ok);
    el.addEventListener("error", fail);
  });
}

function seek(video, t) {
  return new Promise((res) => {
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); res(); };
    video.addEventListener("seeked", onSeeked);
    // Nudge if the seek doesn't fire (some encodings stall on exact times).
    video.currentTime = t;
    setTimeout(() => { video.removeEventListener("seeked", onSeeked); res(); }, 2000);
  });
}

// Decode the file's audio via WebAudio, resample to 48k mono, encode Opus.
async function encodeAudio(file) {
  const buf = await file.arrayBuffer();
  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmpCtx.decodeAudioData(buf.slice(0));
  tmpCtx.close();

  const sampleRate = 48000;
  const length = Math.ceil(decoded.duration * sampleRate);
  const off = new OfflineAudioContext(1, length, sampleRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0); // Float32, mono, 48k

  const chunks = [];
  let config = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => { if (meta?.decoderConfig) config = meta.decoderConfig; chunks.push({ chunk, meta }); },
    error: (e) => { throw e; },
  });
  enc.configure({ codec: "opus", sampleRate, numberOfChannels: 1, bitrate: 24000 });

  // Feed in ~20ms frames.
  const frameSize = sampleRate * 0.02;
  for (let i = 0; i < pcm.length; i += frameSize) {
    const slice = pcm.subarray(i, Math.min(pcm.length, i + frameSize));
    const data = new Float32Array(slice); // copy
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: Math.round((i / sampleRate) * 1_000_000),
      data,
    });
    enc.encode(audioData);
    audioData.close();
  }
  await enc.flush();
  enc.close();
  return { chunks, config };
}
