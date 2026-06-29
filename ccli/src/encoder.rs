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

use crate::worker_client;

pub struct RemoteEncoder {
    pub base_url: String,
}

impl SegmentEncoder for RemoteEncoder {
    fn encode(&self, src: &Path, dst: &Path, p: &Preset, cap1080: bool) -> Result<(), EncodeErr> {
        let body = std::fs::read(src).map_err(|e| EncodeErr::Fatal(format!("read {src:?}: {e}")))?;
        let out = worker_client::encode(&self.base_url, p.name, cap1080, &body)?;
        std::fs::write(dst, &out).map_err(|e| EncodeErr::Fatal(format!("write {dst:?}: {e}")))?;
        Ok(())
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

    #[test]
    fn remote_encoder_unreachable_is_transient() {
        // A worker that isn't listening → transport error → Transient (retryable),
        // never Fatal. Uses a port nothing is bound to.
        let enc = RemoteEncoder { base_url: "http://127.0.0.1:1".into() };
        // create a tiny real input file so the read() succeeds and we reach the POST
        let dir = std::env::temp_dir().join(format!("enc_rt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.mkv");
        std::fs::write(&src, b"not really mkv").unwrap();
        let r = enc.encode(&src, &dir.join("out.mp4"), preset("screencast").unwrap(), true);
        std::fs::remove_dir_all(&dir).ok();
        assert!(matches!(r, Err(EncodeErr::Transient(_))), "got {r:?}");
    }
}
