// HTTP client for tinv-worker. Synchronous (ureq). Capacity JSON is our own
// minimal format, parsed by hand to avoid a JSON dependency.
use std::io::Read;
use std::time::Duration;

use crate::encoder::EncodeErr;

pub struct Capacity {
    pub cores: usize,
    pub slots: usize,
    pub svtav1: bool,
}

fn grab_num(body: &str, key: &str) -> Option<usize> {
    let k = format!("\"{}\":", key);
    let i = body.find(&k)? + k.len();
    let rest = body[i..].trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

pub fn parse_capacity(body: &str) -> Result<Capacity, String> {
    let cores = grab_num(body, "cores").ok_or("missing cores")?;
    let slots = grab_num(body, "slots").ok_or("missing slots")?;
    let svtav1 = body.contains("\"svtav1\":true");
    Ok(Capacity { cores, slots, svtav1 })
}

pub fn capacity(base_url: &str) -> Result<Capacity, String> {
    let resp = ureq::get(&format!("{base_url}/capacity"))
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?;
    let body = resp.into_string().map_err(|e| e.to_string())?;
    parse_capacity(&body)
}

pub fn encode(base_url: &str, preset: &str, cap1080: bool, body: &[u8]) -> Result<Vec<u8>, EncodeErr> {
    let url = format!("{base_url}/encode?preset={preset}&cap1080={}", if cap1080 { 1 } else { 0 });
    match ureq::post(&url).send_bytes(body) {
        Ok(resp) => {
            let mut v = Vec::new();
            resp.into_reader()
                .read_to_end(&mut v)
                .map_err(|e| EncodeErr::Transient(e.to_string()))?;
            Ok(v)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let msg = resp.into_string().unwrap_or_default();
            if (400..500).contains(&code) {
                Err(EncodeErr::Fatal(format!("worker {code}: {msg}")))
            } else {
                Err(EncodeErr::Transient(format!("worker {code}: {msg}")))
            }
        }
        Err(ureq::Error::Transport(t)) => Err(EncodeErr::Transient(t.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_capacity_json() {
        let c = parse_capacity("{\"cores\":12,\"slots\":4,\"svtav1\":true}").unwrap();
        assert_eq!(c.cores, 12);
        assert_eq!(c.slots, 4);
        assert!(c.svtav1);
    }

    #[test]
    fn capacity_without_svtav1_is_false() {
        let c = parse_capacity("{\"cores\":8,\"slots\":4,\"svtav1\":false}").unwrap();
        assert!(!c.svtav1);
    }

    #[test]
    fn missing_fields_error() {
        assert!(parse_capacity("{\"cores\":8}").is_err());
    }
}
