// Minimal ffmpeg helpers for the Rust CLI's interop tests. Self-contained — no
// dependency on the archived JS CLI (cli-old). Resolves the bundled ffmpeg that
// lives alongside this crate at cli/ffmpeg/, falling back to PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function resolveBin(name) {
  const bundled = join(here, "ffmpeg", name);
  return existsSync(bundled) ? bundled : name;
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

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}
