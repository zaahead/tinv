// Pure request helpers for tinv-worker, kept separate from the server loop so
// they can be unit-tested without sockets.

/// Parse `/encode?preset=<name>&cap1080=<0|1>` → (preset, cap1080).
pub fn parse_encode_query(url: &str) -> Result<(String, bool), String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut preset: Option<String> = None;
    let mut cap1080 = true;
    for pair in q.split('&') {
        match pair.split_once('=') {
            Some(("preset", v)) => preset = Some(v.to_string()),
            Some(("cap1080", v)) => cap1080 = v != "0",
            _ => {}
        }
    }
    preset.map(|p| (p, cap1080)).ok_or_else(|| "missing preset".into())
}

pub fn capacity_json(cores: usize, slots: usize, svtav1: bool) -> String {
    format!("{{\"cores\":{cores},\"slots\":{slots},\"svtav1\":{svtav1}}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_encode_query() {
        assert_eq!(parse_encode_query("/encode?preset=near&cap1080=0").unwrap(), ("near".into(), false));
        assert_eq!(parse_encode_query("/encode?preset=screencast&cap1080=1").unwrap(), ("screencast".into(), true));
        assert_eq!(parse_encode_query("/encode?preset=squeeze").unwrap(), ("squeeze".into(), true));
    }

    #[test]
    fn missing_preset_errors() {
        assert!(parse_encode_query("/encode?cap1080=1").is_err());
    }

    #[test]
    fn capacity_json_shape() {
        assert_eq!(capacity_json(12, 4, true), "{\"cores\":12,\"slots\":4,\"svtav1\":true}");
    }
}
