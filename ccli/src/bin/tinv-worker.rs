// tinv-worker — stateless HTTP encode worker. Runs the same segment encode as
// the local path. Concurrency is bounded by the coordinator (it opens at most
// `slots` connections); we spawn a thread per request.
//
//   tinv-worker [bind_addr]   (default 0.0.0.0:7878)
use std::sync::atomic::{AtomicU64, Ordering};

use ccli::{ffmpeg, pool, preset, worker};
use tiny_http::{Method, Response, Server};

fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "0.0.0.0:7878".into());
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let slots = pool::default_jobs(cores);
    let lp = pool::lp_for(cores, slots);
    let ffmpeg_bin = ffmpeg::resolve_bin("ffmpeg");
    let svtav1 = ffmpeg::has_svtav1(&ffmpeg_bin);

    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("tinv-worker: cannot bind {addr}: {e}");
        std::process::exit(1);
    });
    eprintln!("tinv-worker on {addr}: cores={cores} slots={slots} lp={lp} svtav1={svtav1}");

    static SEQ: AtomicU64 = AtomicU64::new(0);

    for mut req in server.incoming_requests() {
        let ffmpeg_bin = ffmpeg_bin.clone();
        std::thread::spawn(move || {
            let url = req.url().to_string();
            let is_capacity = req.method() == &Method::Get && url.starts_with("/capacity");
            let is_encode = req.method() == &Method::Post && url.starts_with("/encode");

            if is_capacity {
                let body = worker::capacity_json(cores, slots, svtav1);
                let _ = req.respond(Response::from_string(body).with_status_code(200));
                return;
            }
            if !is_encode {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
                return;
            }

            let (preset_name, cap1080) = match worker::parse_encode_query(&url) {
                Ok(v) => v,
                Err(e) => {
                    let _ = req.respond(Response::from_string(e).with_status_code(400));
                    return;
                }
            };
            let p = match preset::preset(&preset_name) {
                Some(p) => p,
                None => {
                    let _ = req.respond(Response::from_string("unknown preset").with_status_code(400));
                    return;
                }
            };

            // Read the uploaded segment to a temp .mkv.
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!("tinvw_{}_{}", std::process::id(), n));
            let src = base.with_extension("mkv");
            let dst = base.with_extension("mp4");
            let mut bytes = Vec::new();
            if req.as_reader().read_to_end(&mut bytes).is_err() {
                let _ = req.respond(Response::from_string("read body failed").with_status_code(400));
                return;
            }
            if std::fs::write(&src, &bytes).is_err() {
                let _ = req.respond(Response::from_string("temp write failed").with_status_code(500));
                return;
            }

            let abort = std::sync::atomic::AtomicBool::new(false);
            let args = ffmpeg::segment_encode_args(&src.to_string_lossy(), &dst.to_string_lossy(), p, cap1080, lp);
            let result = ffmpeg::run_ffmpeg(&ffmpeg_bin, &args, &abort);

            let response = match result {
                Ok(()) => match std::fs::read(&dst) {
                    Ok(out) => Response::from_data(out).with_status_code(200),
                    Err(e) => Response::from_string(format!("read output: {e}")).with_status_code(500),
                },
                // ffmpeg rejected the segment → client must not retry: 400 (fatal).
                Err(e) => Response::from_string(e).with_status_code(400),
            };
            let _ = req.respond(response);
            let _ = std::fs::remove_file(&src);
            let _ = std::fs::remove_file(&dst);
        });
    }
}
