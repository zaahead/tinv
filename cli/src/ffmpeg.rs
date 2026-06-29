// All ffmpeg/ffprobe interaction: binary resolution, probing, arg building, run.
// Arg vectors mirror cli/ffmpeg.js so cli output stays equivalent.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::preset::{gop_for, Preset};

const FRAG: &[&str] = &[
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "2000000",
];

fn s(v: &str) -> String {
    v.to_string()
}

/// Resolve a bundled binary (`ffmpeg`/`ffprobe`), falling back to PATH.
pub fn resolve_bin(name: &str) -> String {
    if let Ok(p) = std::env::var(format!("TINV_{}", name.to_uppercase())) {
        if !p.is_empty() {
            return p;
        }
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("cli/ffmpeg").join(name),
        PathBuf::from("../cli/ffmpeg").join(name),
        PathBuf::from(name),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.insert(0, dir.join("ffmpeg").join(name));
            candidates.insert(1, dir.join("..").join("cli").join("ffmpeg").join(name));
        }
    }
    for c in &candidates {
        if c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

pub fn has_svtav1(ffmpeg: &str) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| {
            let mut t = o.stdout;
            t.extend_from_slice(&o.stderr);
            String::from_utf8_lossy(&t).contains("libsvtav1")
        })
        .unwrap_or(false)
}

pub struct Probe {
    pub duration: f64,
    pub has_audio: bool,
}

pub fn probe(ffprobe: &str, src: &str) -> Probe {
    let mut p = Probe { duration: 0.0, has_audio: false };
    if let Ok(o) = Command::new(ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type",
            "-of", "default=noprint_wrappers=1",
            src,
        ])
        .output()
    {
        let out = String::from_utf8_lossy(&o.stdout);
        for line in out.lines() {
            if let Some(v) = line.strip_prefix("duration=") {
                p.duration = v.trim().parse().unwrap_or(0.0);
            }
            if line == "codec_type=audio" {
                p.has_audio = true;
            }
        }
    }
    p
}

fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

fn video_filter(p: &Preset, cap1080: bool) -> String {
    let mut vf = vec![format!("fps={}", p.fps)];
    if cap1080 {
        vf.push("scale=-2:'min(1080,ih)'".into());
    }
    if p.denoise {
        vf.push("hqdn3d=2:1:2:3".into());
    }
    vf.join(",")
}

// `lp` bounds the encoder's thread count; 0 leaves SVT-AV1 on auto (whole file).
fn video_codec(p: &Preset, lp: usize) -> Vec<String> {
    let mut params = String::from("tune=0");
    if lp > 0 {
        params.push_str(&format!(":lp={}", lp));
    }
    vec![
        s("-c:v"), s("libsvtav1"),
        s("-crf"), p.crf.to_string(),
        s("-preset"), p.svt.to_string(),
        s("-g"), gop_for(p.fps).to_string(),
        s("-svtav1-params"), params,
    ]
}

pub fn whole_file_args(src: &str, dst: &str, p: &Preset, cap1080: bool, has_audio: bool) -> Vec<String> {
    let mut a = vec![s("-y"), s("-i"), s(src)];
    a.extend(video_codec(p, 0));
    a.push(s("-vf"));
    a.push(video_filter(p, cap1080));
    if has_audio {
        a.extend([s("-c:a"), s("libopus"), s("-b:a"), format!("{}k", p.audio), s("-ac"), s("1")]);
    } else {
        a.push(s("-an"));
    }
    a.extend(FRAG.iter().map(|x| s(x)));
    a.extend([s("-f"), s("mp4"), s(dst)]);
    a
}

pub fn split_args(src: &str, dst_pattern: &str, seg_len: f64) -> Vec<String> {
    vec![
        s("-y"), s("-i"), s(src), s("-map"), s("0:v:0"), s("-c"), s("copy"),
        s("-f"), s("segment"), s("-segment_time"), fmt_num(seg_len),
        s("-reset_timestamps"), s("1"), s(dst_pattern),
    ]
}

pub fn segment_encode_args(src: &str, dst: &str, p: &Preset, cap1080: bool, lp: usize) -> Vec<String> {
    let mut a = vec![s("-y"), s("-i"), s(src)];
    a.extend(video_codec(p, lp));
    a.push(s("-vf"));
    a.push(video_filter(p, cap1080));
    a.extend([s("-an"), s("-f"), s("mp4"), s(dst)]);
    a
}

pub fn concat_args(list_file: &str, dst: &str) -> Vec<String> {
    vec![
        s("-y"), s("-f"), s("concat"), s("-safe"), s("0"), s("-i"), s(list_file),
        s("-c"), s("copy"), s("-f"), s("mp4"), s(dst),
    ]
}

pub fn audio_args(src: &str, dst: &str, p: &Preset) -> Vec<String> {
    vec![
        s("-y"), s("-i"), s(src), s("-vn"), s("-c:a"), s("libopus"),
        s("-b:a"), format!("{}k", p.audio), s("-ac"), s("1"), s("-f"), s("ogg"), s(dst),
    ]
}

pub fn mux_fragment_args(video: &str, audio: Option<&str>, dst: &str) -> Vec<String> {
    let mut a = vec![s("-y"), s("-i"), s(video)];
    if let Some(au) = audio {
        a.extend([s("-i"), s(au)]);
    }
    a.extend([s("-c"), s("copy")]);
    a.extend(FRAG.iter().map(|x| s(x)));
    a.extend([s("-f"), s("mp4"), s(dst)]);
    a
}

/// Run ffmpeg, draining stderr into a rolling tail so failures are diagnosable.
/// Polls `abort` and kills the child if a sibling task fails.
pub fn run_ffmpeg(ffmpeg: &str, args: &[String], abort: &AtomicBool) -> Result<(), String> {
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;

    let stderr = child.stderr.take().unwrap();
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let t2 = tail.clone();
    let reader = std::thread::spawn(move || {
        let mut r = stderr;
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut g = t2.lock().unwrap();
                    g.extend_from_slice(&buf[..n]);
                    let len = g.len();
                    if len > 4000 {
                        g.drain(..len - 2000);
                    }
                }
            }
        }
    });

    loop {
        if abort.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("aborted".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = reader.join();
                if status.success() {
                    return Ok(());
                }
                let g = tail.lock().unwrap();
                let text = String::from_utf8_lossy(&g);
                let last: Vec<&str> = text.trim().lines().rev().take(3).collect();
                let last: Vec<&str> = last.into_iter().rev().collect();
                let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                return Err(format!("ffmpeg exited {code}: {}", last.join(" | ")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("wait ffmpeg: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::preset;

    fn has(a: &[String], needle: &str) -> bool {
        a.iter().any(|x| x == needle)
    }

    #[test]
    fn whole_file_encodes_av1_opus_fragmented_with_audio() {
        let a = whole_file_args("in.mp4", "out.mp4", preset("screencast").unwrap(), true, true);
        assert!(has(&a, "libsvtav1"));
        assert!(has(&a, "libopus"));
        assert!(has(&a, "+frag_keyframe+empty_moov+default_base_moof"));
        assert_eq!(a.last().unwrap(), "out.mp4");
    }

    #[test]
    fn whole_file_uses_an_without_audio_and_no_lp() {
        let a = whole_file_args("in.mp4", "out.mp4", preset("screencast").unwrap(), true, false);
        assert!(has(&a, "-an"));
        assert!(!has(&a, "libopus"));
        let params = &a[a.iter().position(|x| x == "-svtav1-params").unwrap() + 1];
        assert!(!params.contains("lp="), "whole-file must not pin lp: {params}");
    }

    #[test]
    fn segment_encode_pins_lp_and_is_video_only() {
        let a = segment_encode_args("seg.mkv", "enc.mp4", preset("talkinghead").unwrap(), true, 4);
        assert!(has(&a, "-an"));
        assert!(!has(&a, "+frag_keyframe+empty_moov+default_base_moof"));
        let params = &a[a.iter().position(|x| x == "-svtav1-params").unwrap() + 1];
        assert!(params.contains("lp=4"), "{params}");
    }

    #[test]
    fn split_copy_splits_by_segment_time() {
        assert_eq!(
            split_args("in.mp4", "seg_%04d.mkv", 30.0),
            vec![
                "-y", "-i", "in.mp4", "-map", "0:v:0", "-c", "copy",
                "-f", "segment", "-segment_time", "30", "-reset_timestamps", "1",
                "seg_%04d.mkv",
            ]
        );
    }

    #[test]
    fn mux_audio_is_optional() {
        let with_a = mux_fragment_args("v.mp4", Some("a.ogg"), "out.mp4");
        assert!(has(&with_a, "a.ogg"));
        let no_a = mux_fragment_args("v.mp4", None, "out.mp4");
        assert!(!has(&no_a, "a.ogg"));
    }
}
