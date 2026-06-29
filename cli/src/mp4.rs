// Fragmented-MP4 box walking + chunk grouping. Mirrors the segmentation half of
// cli/tinv-format.js (splitMp4Fragments / groupClusters) so the TINV3 segment
// table matches byte-for-byte.

use std::ops::Range;

// Chunk ramp: first chunk tiny (start playing ASAP), then geometric to a cap.
const FIRST_CHUNK_BYTES: usize = 48 * 1024;
const MAX_CHUNK_BYTES: usize = 512 * 1024;
const CHUNK_GROWTH: usize = 2;

struct Box {
    type_: [u8; 4],
    start: usize,
    size: usize,
}

// Walk one top-level box: [u32 size][4-char type][...]. size 1 ⇒ 64-bit size
// follows the type; size 0 ⇒ extends to EOF.
fn read_box(b: &[u8], off: usize) -> Option<Box> {
    if off + 8 > b.len() {
        return None;
    }
    let mut size = u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]) as usize;
    let type_ = [b[off + 4], b[off + 5], b[off + 6], b[off + 7]];
    let mut header_len = 8;
    if size == 1 {
        if off + 16 > b.len() {
            return None;
        }
        size = u64::from_be_bytes([
            b[off + 8], b[off + 9], b[off + 10], b[off + 11],
            b[off + 12], b[off + 13], b[off + 14], b[off + 15],
        ]) as usize;
        header_len = 16;
    } else if size == 0 {
        size = b.len() - off;
    }
    if size < header_len {
        return None;
    }
    Some(Box { type_, start: off, size })
}

pub struct Fragments {
    pub init: Range<usize>,
    pub clusters: Vec<Range<usize>>,
}

/// Split an fMP4 into an init segment (everything before the first `moof`) and N
/// media fragments (one `moof`+`mdat` pair each). Returns `None` if the layout
/// isn't fragmented MP4.
pub fn split_mp4_fragments(b: &[u8]) -> Option<Fragments> {
    let n = b.len();
    let mut off = 0;
    let mut first_moof: Option<usize> = None;
    let mut frag_starts: Vec<usize> = Vec::new();

    while off < n {
        let bx = match read_box(b, off) {
            Some(x) => x,
            None => break,
        };
        if &bx.type_ == b"moof" {
            if first_moof.is_none() {
                first_moof = Some(bx.start);
            }
            frag_starts.push(bx.start);
        }
        off = bx.start + bx.size;
        if bx.size == 0 {
            break;
        }
    }

    let first_moof = first_moof?;
    if frag_starts.is_empty() {
        return None;
    }

    let clusters = frag_starts
        .iter()
        .enumerate()
        .map(|(i, &start)| {
            let end = frag_starts.get(i + 1).copied().unwrap_or(n);
            start..end
        })
        .collect();

    Some(Fragments { init: 0..first_moof, clusters })
}

/// Group consecutive fragments into chunks with a ramped target size. Each
/// returned chunk is the concatenated bytes of its fragments and starts on a
/// `moof` boundary.
pub fn group_clusters(b: &[u8], clusters: &[Range<usize>]) -> Vec<Vec<u8>> {
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut target = FIRST_CHUNK_BYTES;

    for r in clusters {
        cur.extend_from_slice(&b[r.clone()]);
        if cur.len() >= target {
            chunks.push(std::mem::take(&mut cur));
            target = (target * CHUNK_GROWTH).min(MAX_CHUNK_BYTES);
        }
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a box: 4-byte BE size, 4-char type, then `body` bytes.
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
        v.extend(boxx(b"moov", &[0u8; 40]));
        v.extend(boxx(b"moof", &[1u8; 10]));
        v.extend(boxx(b"mdat", &[2u8; 20]));
        v.extend(boxx(b"moof", &[3u8; 10]));
        v.extend(boxx(b"mdat", &[4u8; 20]));
        v
    }

    #[test]
    fn split_finds_init_and_two_fragments() {
        let mp4 = sample_fmp4();
        let f = split_mp4_fragments(&mp4).unwrap();
        // init = ftyp + moov
        assert_eq!(f.init, 0..(8 + 4 + 8 + 40));
        assert_eq!(f.clusters.len(), 2);
        // each cluster is moof(18) + mdat(28) = 46 bytes
        assert_eq!(f.clusters[0].len(), 46);
        assert_eq!(f.clusters[1].end, mp4.len());
    }

    #[test]
    fn non_fragmented_returns_none() {
        let mut v = Vec::new();
        v.extend(boxx(b"ftyp", b"isom"));
        v.extend(boxx(b"moov", &[0u8; 40]));
        v.extend(boxx(b"mdat", &[2u8; 20]));
        assert!(split_mp4_fragments(&v).is_none());
    }

    #[test]
    fn grouping_ramps_and_covers_all_bytes() {
        // 200 fragments of 1 KB each → grouping must preserve total bytes.
        let frag = vec![7u8; 1024];
        let mut b = Vec::new();
        let mut clusters = Vec::new();
        for _ in 0..200 {
            let start = b.len();
            b.extend_from_slice(&frag);
            clusters.push(start..b.len());
        }
        let chunks = group_clusters(&b, &clusters);
        let total: usize = chunks.iter().map(|c| c.len()).sum();
        assert_eq!(total, 200 * 1024);
        // first chunk reaches the 48 KB target on the 48th fragment
        assert_eq!(chunks[0].len(), 48 * 1024);
        // no chunk exceeds the 512 KB cap by more than one fragment
        assert!(chunks.iter().all(|c| c.len() <= 512 * 1024 + 1024));
    }
}
