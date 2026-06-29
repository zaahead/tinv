// SegmentEncoder abstracts where a single segment is encoded (local ffmpeg or a
// remote worker). EncodeErr separates retryable failures from fatal ones.
use std::path::Path;

use crate::ffmpeg;
use crate::preset::Preset;

#[derive(Debug)]
pub enum EncodeErr {
    Transient(String),
    Fatal(String),
}

pub trait SegmentEncoder: Send + Sync {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr>;
}

pub struct LocalEncoder {
    pub ffmpeg: String,
    pub lp: usize,
}

impl SegmentEncoder for LocalEncoder {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr> {
        use std::sync::atomic::AtomicBool;
        let abort = AtomicBool::new(false);
        let args = ffmpeg::segment_encode_args(
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
            p,
            cap1080,
            self.lp,
        );
        ffmpeg::run_ffmpeg(&self.ffmpeg, &args, &abort).map_err(EncodeErr::Fatal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::preset;

    #[test]
    fn local_encoder_maps_ffmpeg_failure_to_fatal() {
        // A bogus ffmpeg binary makes run_ffmpeg fail; LocalEncoder must surface
        // that as Fatal (today's behavior: local errors abort the job).
        let enc = LocalEncoder { ffmpeg: "/nonexistent/ffmpeg".into(), lp: 1 };
        let r = enc.encode(
            Path::new("/tmp/in.mkv"),
            Path::new("/tmp/out.mp4"),
            preset("screencast").unwrap(),
            true,
        );
        assert!(matches!(r, Err(EncodeErr::Fatal(_))));
    }
}
