// TINV3 streaming container writer. WIRE-COMPATIBLE with web/tinv-format.js and
// cli/tinv-format.js — the bytes produced here must decode in the web app and
// extension. Container layout (little-endian):
//
//   magic     5    "TINV3"
//   salt      16   random per file (base AES-CTR counter block)
//   metaLen   4    u32, length of the JSON metadata
//   metadata       UTF-8 JSON, carries meta._tinv = { initLen, chunkLens:[...] }
//   initSeg        AES-CTR(ftyp + moov)
//   chunk[..]      AES-CTR(one or more moof+mdat fragments each)
//
// Key = SHA-256(SECRET ‖ salt). Base counter = the 16-byte salt; all segments
// share one continuous keystream, each starting at a whole-block offset.

use aes::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use aes::Aes256;
use sha2::{Digest, Sha256};

use crate::mp4;

type Ctr64 = ctr::Ctr64BE<Aes256>;

const MAGIC2: &[u8; 5] = b"TINV2";
const MAGIC3: &[u8; 5] = b"TINV3";
const SALT_LEN: usize = 16;
const SECRET: &[u8] = b"tinv-v1-7Qm2pX9sLraF0bKzVtNcUeWdHgYjBoIw";

/// Informational metadata carried in the container header. Only `_tinv`
/// (computed here) is read by the players; the rest is descriptive.
pub struct Meta {
    pub title: String,
    pub source_size_bytes: u64,
}

fn derive_key(salt: &[u8; SALT_LEN]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(SECRET);
    h.update(salt);
    h.finalize().into()
}

fn blocks(len: usize) -> u64 {
    ((len + 15) / 16) as u64
}

fn random_salt() -> [u8; SALT_LEN] {
    use std::io::Read;
    let mut salt = [0u8; SALT_LEN];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut salt))
        .expect("read /dev/urandom");
    salt
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Wrap a fragmented-MP4 byte slice into a TINV3 container. Falls back to TINV2
/// (whole-file encryption) if the input can't be split on `moof` boundaries.
pub fn encode_tinv_stream(mp4_bytes: &[u8], meta: &Meta) -> Vec<u8> {
    encode_with_salt(mp4_bytes, meta, random_salt())
}

fn encode_with_salt(mp4_bytes: &[u8], meta: &Meta, salt: [u8; SALT_LEN]) -> Vec<u8> {
    let split = match mp4::split_mp4_fragments(mp4_bytes) {
        Some(s) => s,
        None => return encode_tinv2(mp4_bytes, meta, salt),
    };

    let init = &mp4_bytes[split.init.clone()];
    let chunks = mp4::group_clusters(mp4_bytes, &split.clusters);

    let key = derive_key(&salt);
    let mut cipher = Ctr64::new(&key.into(), &salt.into());

    // One continuous keystream across [init, chunk0, chunk1, ...]; each segment
    // starts at the next whole-block offset (matching the JS counterAdd scheme).
    let mut enc_init = init.to_vec();
    cipher.seek(0u64);
    cipher.apply_keystream(&mut enc_init);
    let mut block_off = blocks(init.len());

    let mut enc_chunks: Vec<Vec<u8>> = Vec::with_capacity(chunks.len());
    let chunk_lens: Vec<usize> = chunks.iter().map(|c| c.len()).collect();
    for c in &chunks {
        let mut e = c.clone();
        cipher.seek(block_off * 16);
        cipher.apply_keystream(&mut e);
        enc_chunks.push(e);
        block_off += blocks(c.len());
    }

    let chunk_lens_json = chunk_lens
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let meta_json = format!(
        "{{\"version\":1,\"title\":\"{}\",\"sourceSizeBytes\":{},\"encodedSizeBytes\":{},\"chapters\":[],\"_tinv\":{{\"initLen\":{},\"chunkLens\":[{}]}}}}",
        json_escape(&meta.title),
        meta.source_size_bytes,
        mp4_bytes.len(),
        init.len(),
        chunk_lens_json,
    );

    let mut out = Vec::new();
    out.extend_from_slice(MAGIC3);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(meta_json.as_bytes());
    out.extend_from_slice(&enc_init);
    for c in &enc_chunks {
        out.extend_from_slice(c);
    }
    out
}

// TINV2 fallback: whole payload encrypted as one segment.
fn encode_tinv2(payload: &[u8], meta: &Meta, salt: [u8; SALT_LEN]) -> Vec<u8> {
    let key = derive_key(&salt);
    let mut cipher = Ctr64::new(&key.into(), &salt.into());
    let mut enc = payload.to_vec();
    cipher.apply_keystream(&mut enc);

    let meta_json = format!(
        "{{\"version\":1,\"title\":\"{}\",\"sourceSizeBytes\":{},\"encodedSizeBytes\":{},\"chapters\":[]}}",
        json_escape(&meta.title),
        meta.source_size_bytes,
        payload.len(),
    );

    let mut out = Vec::new();
    out.extend_from_slice(MAGIC2);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(meta_json.as_bytes());
    out.extend_from_slice(&enc);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Decrypt helper mirroring the player: re-derive the key and run the same
    // continuous keystream over the encrypted segments.
    fn decrypt_stream(container: &[u8]) -> (Vec<u8>, String) {
        assert_eq!(&container[0..5], MAGIC3);
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&container[5..21]);
        let meta_len =
            u32::from_le_bytes([container[21], container[22], container[23], container[24]]) as usize;
        let meta = String::from_utf8(container[25..25 + meta_len].to_vec()).unwrap();
        let payload = &container[25 + meta_len..];

        let key = derive_key(&salt);
        let mut cipher = Ctr64::new(&key.into(), &salt.into());
        let mut clear = payload.to_vec();
        // Decrypt by replaying the same block-aligned keystream segment by
        // segment using initLen + chunkLens parsed from the metadata.
        let init_len: usize = grab(&meta, "initLen");
        let chunk_lens = grab_array(&meta, "chunkLens");

        let mut pos = 0;
        let mut block_off = 0u64;
        for len in std::iter::once(init_len).chain(chunk_lens.iter().copied()) {
            cipher.seek(block_off * 16);
            cipher.apply_keystream(&mut clear[pos..pos + len]);
            pos += len;
            block_off += blocks(len);
        }
        (clear, meta)
    }

    fn grab(meta: &str, key: &str) -> usize {
        let k = format!("\"{}\":", key);
        let i = meta.find(&k).unwrap() + k.len();
        let rest = &meta[i..];
        let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        rest[..end].parse().unwrap()
    }

    fn grab_array(meta: &str, key: &str) -> Vec<usize> {
        let k = format!("\"{}\":[", key);
        let i = meta.find(&k).unwrap() + k.len();
        let rest = &meta[i..];
        let end = rest.find(']').unwrap();
        rest[..end]
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse().unwrap())
            .collect()
    }

    fn boxx(type_: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let size = (8 + body.len()) as u32;
        let mut v = size.to_be_bytes().to_vec();
        v.extend_from_slice(type_);
        v.extend_from_slice(body);
        v
    }

    fn sample_fmp4() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(boxx(b"ftyp", b"isom"));
        v.extend(boxx(b"moov", &[9u8; 37])); // odd length → init not block-aligned
        v.extend(boxx(b"moof", &[1u8; 11]));
        v.extend(boxx(b"mdat", &[2u8; 5000]));
        v.extend(boxx(b"moof", &[3u8; 11]));
        v.extend(boxx(b"mdat", &[4u8; 70000]));
        v
    }

    #[test]
    fn roundtrip_decrypts_to_original_fmp4() {
        let mp4 = sample_fmp4();
        let meta = Meta { title: "clip \"x\"".into(), source_size_bytes: 12345 };
        let container = encode_with_salt(&mp4, &meta, [7u8; SALT_LEN]);
        let (clear, meta_json) = decrypt_stream(&container);
        assert_eq!(clear, mp4, "decrypted payload must equal the input fMP4");
        assert!(meta_json.contains("\"_tinv\""));
        assert!(meta_json.contains("\"title\":\"clip \\\"x\\\"\""));
    }

    #[test]
    fn header_layout_matches_spec() {
        let mp4 = sample_fmp4();
        let meta = Meta { title: "t".into(), source_size_bytes: 1 };
        let c = encode_with_salt(&mp4, &meta, [0u8; SALT_LEN]);
        assert_eq!(&c[0..5], b"TINV3");
        assert_eq!(&c[5..21], &[0u8; 16]);
        let meta_len = u32::from_le_bytes([c[21], c[22], c[23], c[24]]) as usize;
        // payload after header equals total fMP4 length (CTR keeps size)
        let payload_len = c.len() - (25 + meta_len);
        assert_eq!(payload_len, mp4.len());
    }
}
