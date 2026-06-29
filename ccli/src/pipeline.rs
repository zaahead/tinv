// Per-file orchestration: decide whole-file vs chunked, encode, wrap as TINV3.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use ccli::encoder::{LocalEncoder, RemoteEncoder};
use ccli::ffmpeg;
use ccli::preset::Preset;
use ccli::scheduler::{self, Executor, Job};
use ccli::tinv::{self, Meta};

#[derive(Clone)]
pub struct WorkerSlot {
    pub base_url: String,
    pub slots: usize,
}

pub struct Opts {
    pub cap1080: bool,
    pub seg_len: f64,
    pub min_split: f64,
    pub jobs: usize,
    pub lp: usize,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub workers: Vec<WorkerSlot>,
}

/// Per-file progress printer. Inline mode (single file on a TTY) updates one
/// line in place; otherwise it prints milestone lines.
pub struct Progress {
    pub name: String,
    pub inline: bool,
}

impl Progress {
    pub fn whole(&self) {
        println!("  {}: encoding…", self.name);
    }
    pub fn split(&self, total: usize) {
        println!("  {}: split into {} segments", self.name, total);
    }
    pub fn segment(&self, done: usize, total: usize) {
        if self.inline {
            print!("\r  {}: encoded {}/{} segments", self.name, done, total);
            if done == total {
                println!();
            }
            let _ = std::io::stdout().flush();
        } else {
            println!("  {}: encoded {}/{} segments", self.name, done, total);
        }
    }
    pub fn concat(&self) {
        println!("  {}: concatenating + muxing…", self.name);
    }
}

pub fn should_chunk(duration: f64, min_split: f64) -> bool {
    duration >= min_split && duration > 0.0
}

fn make_temp_dir() -> std::io::Result<PathBuf> {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("tinv_{}_{}_{}", std::process::id(), nanos, n));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn convert_one(
    src: &str,
    dst: &str,
    p: &Preset,
    opts: &Opts,
    progress: &Progress,
) -> Result<(u64, u64), String> {
    let pr = ffmpeg::probe(&opts.ffprobe, src);
    let src_bytes = std::fs::metadata(src).map_err(|e| format!("stat {src}: {e}"))?.len();
    let work = make_temp_dir().map_err(|e| format!("mktemp: {e}"))?;

    let run = || -> Result<(u64, u64), String> {
        let fmp4: PathBuf = if should_chunk(pr.duration, opts.min_split) {
            encode_chunked(src, &work, p, opts, pr.has_audio, progress)?
        } else {
            progress.whole();
            let out = work.join("out.mp4");
            let abort = AtomicBool::new(false);
            ffmpeg::run_ffmpeg(
                &opts.ffmpeg,
                &ffmpeg::whole_file_args(src, &out.to_string_lossy(), p, opts.cap1080, pr.has_audio),
                &abort,
            )?;
            out
        };

        let video = std::fs::read(&fmp4).map_err(|e| format!("read encoded: {e}"))?;
        let title = Path::new(src)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let container = tinv::encode_tinv_stream(&video, &Meta { title, source_size_bytes: src_bytes });
        std::fs::write(dst, &container).map_err(|e| format!("write {dst}: {e}"))?;
        Ok((src_bytes, container.len() as u64))
    };

    let result = run();
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn encode_chunked(
    src: &str,
    work: &Path,
    p: &Preset,
    opts: &Opts,
    has_audio: bool,
    progress: &Progress,
) -> Result<PathBuf, String> {
    let ff = &opts.ffmpeg;

    // 1. Copy-split the source video at its keyframes into time segments.
    let pattern = work.join("src_%04d.mkv");
    let split_abort = AtomicBool::new(false);
    ffmpeg::run_ffmpeg(ff, &ffmpeg::split_args(src, &pattern.to_string_lossy(), opts.seg_len), &split_abort)?;

    let mut src_segs: Vec<PathBuf> = std::fs::read_dir(work)
        .map_err(|e| format!("read work dir: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.starts_with("src_") && name.ends_with(".mkv")
        })
        .collect();
    src_segs.sort();
    if src_segs.is_empty() {
        return Err("copy-split produced no segments".into());
    }
    let total = src_segs.len();
    progress.split(total);

    // 2. Encode each segment to AV1 video-only across local + remote executors.
    let enc_segs: Vec<PathBuf> = (0..total).map(|i| work.join(format!("enc_{:04}.mp4", i))).collect();

    let mut executors: Vec<Executor> = Vec::new();
    for _ in 0..opts.jobs {
        executors.push(Executor {
            is_local: true,
            encoder: Box::new(LocalEncoder { ffmpeg: opts.ffmpeg.clone(), lp: opts.lp }),
        });
    }
    for w in &opts.workers {
        for _ in 0..w.slots {
            executors.push(Executor {
                is_local: false,
                encoder: Box::new(RemoteEncoder { base_url: w.base_url.clone() }),
            });
        }
    }

    let done = std::sync::atomic::AtomicUsize::new(0);
    let job = Job { src: &src_segs, dst: &enc_segs, preset: p, cap1080: opts.cap1080 };
    let report = |_d: usize, _t: usize| {
        let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        progress.segment(n, total);
    };
    scheduler::run(&job, executors, &report)?;

    // 3. Concat-copy the encoded video segments.
    progress.concat();
    let list_file = work.join("list.txt");
    let list = enc_segs
        .iter()
        .map(|p| format!("file '{}'", p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&list_file, list).map_err(|e| format!("write list: {e}"))?;
    let video_path = work.join("video.mp4");
    let serial = AtomicBool::new(false);
    ffmpeg::run_ffmpeg(ff, &ffmpeg::concat_args(&list_file.to_string_lossy(), &video_path.to_string_lossy()), &serial)?;

    // 4. Encode audio once over the original source.
    let audio_path = if has_audio {
        let ap = work.join("audio.ogg");
        ffmpeg::run_ffmpeg(ff, &ffmpeg::audio_args(src, &ap.to_string_lossy(), p), &serial)?;
        Some(ap)
    } else {
        None
    };

    // 5. Mux + fragment to streaming fMP4.
    let fmp4 = work.join("out.mp4");
    let audio_ref = audio_path.as_ref().map(|p| p.to_string_lossy().into_owned());
    ffmpeg::run_ffmpeg(
        ff,
        &ffmpeg::mux_fragment_args(&video_path.to_string_lossy(), audio_ref.as_deref(), &fmp4.to_string_lossy()),
        &serial,
    )?;
    Ok(fmp4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_only_above_min_split() {
        assert!(should_chunk(120.0, 60.0));
        assert!(should_chunk(60.0, 60.0));
        assert!(!should_chunk(59.0, 60.0));
        assert!(!should_chunk(0.0, 60.0));
    }
}
