// tinv local converter — native Rust orchestrator.
//
//   tinv <input...> [-o out.tinv] [--preset screencast|talkinghead|squeeze|near]
//        [--no-cap] [--jobs N] [--segment SEC] [--min-split SEC]
//
// A bounded thread pool caps concurrent encodes; each SVT-AV1 encode is given
// lp = cores/jobs threads so total threads track the core count. Small files
// encode whole; large files are copy-split, encoded in parallel, concat-copied,
// muxed with one Opus track, fragmented, then wrapped in the TINV3 container so
// the web app and extension can play CLI-made files.

mod ffmpeg;
mod mp4;
mod pipeline;
mod pool;
mod preset;
mod tinv;

use std::io::IsTerminal;
use std::path::Path;

use pipeline::{convert_one, Opts, Progress};

struct Args {
    inputs: Vec<String>,
    preset: String,
    cap1080: bool,
    out: Option<String>,
    jobs: usize,
    seg_len: f64,
    min_split: f64,
}

fn parse_args(argv: &[String], cores: usize) -> Args {
    let mut a = Args {
        inputs: Vec::new(),
        preset: "screencast".into(),
        cap1080: true,
        out: None,
        jobs: pool::default_jobs(cores),
        seg_len: 30.0,
        min_split: 60.0,
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--preset" => { i += 1; a.preset = argv.get(i).cloned().unwrap_or_default(); }
            "--no-cap" => a.cap1080 = false,
            "-o" | "--out" => { i += 1; a.out = argv.get(i).cloned(); }
            "--jobs" => { i += 1; a.jobs = argv.get(i).and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1); }
            "--segment" => { i += 1; a.seg_len = argv.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(30.0).max(1.0); }
            "--min-split" => { i += 1; a.min_split = argv.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0).max(0.0); }
            other => a.inputs.push(other.to_string()),
        }
        i += 1;
    }
    a
}

fn mb(b: u64) -> String {
    format!("{:.1} MB", b as f64 / 1024.0 / 1024.0)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let args = parse_args(&argv, cores);

    if args.inputs.is_empty() {
        eprintln!("Usage: tinv <input...> [--preset {}]", preset::names().join("|"));
        eprintln!("       [--no-cap] [--jobs N] [--segment SEC] [--min-split SEC] [-o out.tinv]");
        std::process::exit(1);
    }
    let p = match preset::preset(&args.preset) {
        Some(p) => p,
        None => {
            eprintln!("Unknown preset \"{}\". Options: {}", args.preset, preset::names().join(", "));
            std::process::exit(1);
        }
    };

    let ffmpeg_bin = ffmpeg::resolve_bin("ffmpeg");
    let ffprobe_bin = ffmpeg::resolve_bin("ffprobe");
    if !ffmpeg::has_svtav1(&ffmpeg_bin) {
        eprintln!("ffmpeg with libsvtav1 not found. Install tinv.app, put a static ffmpeg on PATH, or set TINV_FFMPEG.");
        std::process::exit(1);
    }

    let lp = pool::lp_for(cores, args.jobs);
    println!(
        "tinv: {} file(s), preset={}, jobs={}, lp={}, segment={}s, min-split={}s",
        args.inputs.len(), args.preset, args.jobs, lp, args.seg_len as i64, args.min_split as i64
    );

    let inline = args.inputs.len() == 1 && std::io::stdout().is_terminal();
    let single = args.inputs.len() == 1;
    let mut failures = 0;

    for src in &args.inputs {
        let dst = match (&args.out, single) {
            (Some(o), true) => o.clone(),
            _ => {
                let stem = Path::new(src).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let parent = Path::new(src).parent().unwrap_or(Path::new("."));
                parent.join(format!("{stem}.tinv")).to_string_lossy().into_owned()
            }
        };
        let name = Path::new(src).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| src.clone());
        println!("→ {}  ({})", name, p.label);

        let opts = Opts {
            cap1080: args.cap1080,
            seg_len: args.seg_len,
            min_split: args.min_split,
            jobs: args.jobs,
            lp,
            ffmpeg: ffmpeg_bin.clone(),
            ffprobe: ffprobe_bin.clone(),
        };
        let progress = Progress { name: name.clone(), inline };
        match convert_one(src, &dst, p, &opts, &progress) {
            Ok((src_bytes, out_bytes)) => {
                let ratio = if out_bytes > 0 { src_bytes as f64 / out_bytes as f64 } else { 0.0 };
                println!("  ✓ {}: {} → {}  ({:.1}× smaller)  {}", name, mb(src_bytes), mb(out_bytes), ratio, dst);
            }
            Err(e) => {
                failures += 1;
                eprintln!("  ✗ {}: {}", name, e);
            }
        }
    }

    std::process::exit(if failures > 0 { 1 } else { 0 });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_defaults_and_overrides() {
        let a = parse_args(&["in.mp4".into()], 16);
        assert_eq!(a.inputs, vec!["in.mp4"]);
        assert_eq!(a.preset, "screencast");
        assert!(a.cap1080);
        assert_eq!(a.jobs, 4); // default_jobs(16)

        let a = parse_args(
            &["--preset".into(), "near".into(), "--no-cap".into(), "--jobs".into(), "8".into(), "a.mp4".into(), "b.mp4".into()],
            16,
        );
        assert_eq!(a.preset, "near");
        assert!(!a.cap1080);
        assert_eq!(a.jobs, 8);
        assert_eq!(a.inputs, vec!["a.mp4", "b.mp4"]);
    }
}
