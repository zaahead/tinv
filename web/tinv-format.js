// tinv container format — JS side. Shared by the CLI, PWA, and extension.
//
// A .tinv file is NOT a plain WebM: the WebM payload is encrypted with AES-CTR
// so a browser <video> cannot read it directly. Only the tinv players decode
// it. Metadata JSON is embedded (no sidecar). This is obfuscation, not DRM —
// the secret ships in the player, but it stops casual rename-and-play.
//
// Two container versions are supported:
//
//   TINV2 — single AES-CTR blob over the whole WebM. Must download fully before
//           playing. Kept for decode-compat; new files use TINV3.
//
//   TINV3 — STREAMING. The payload is a fragmented MP4 (fMP4) split on moof
//           boundaries into an init segment (ftyp + moov) and N media fragments
//           (moof+mdat). Each segment is AES-CTR encrypted as part of one
//           continuous keystream (its counter = base salt advanced by the
//           plaintext byte offset / 16), so any segment decrypts independently
//           the moment its bytes arrive. The player feeds them to MediaSource,
//           so playback starts after the init segment + first fragment instead
//           of waiting for the whole file. (fMP4 is used over WebM because
//           browser MediaSource reliably accepts AV1-in-fMP4 but not AV1 in
//           WebM clusters.)
//
// TINV3 layout (little-endian):
//   magic     5    "TINV3"
//   salt      16   random per file (base AES-CTR counter block)
//   metaLen   4    uint32, length of the JSON metadata
//   metadata       UTF-8 JSON. Carries the segment table:
//                    meta._tinv = { initLen, chunkLens: [...] }
//   initSeg        AES-CTR(EBML header + Tracks)
//   chunk[0..n]    AES-CTR(one or more Clusters each)
//
// Key = SHA-256(secret-bytes ‖ salt). Base counter = the 16-byte salt.

const MAGIC2 = [0x54, 0x49, 0x4e, 0x56, 0x32]; // "TINV2"
const MAGIC3 = [0x54, 0x49, 0x4e, 0x56, 0x33]; // "TINV3"
const SALT_LEN = 16;
const SECRET = "tinv-v1-7Qm2pX9sLraF0bKzVtNcUeWdHgYjBoIw";

function u32le(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
function readU32le(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function matchMagic(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** True for any tinv container (TINV2 or TINV3). */
export function isTinv(bytes) {
  return matchMagic(bytes, MAGIC2) || matchMagic(bytes, MAGIC3);
}

const encoder = new TextEncoder();

async function deriveKey(salt) {
  const secretBytes = encoder.encode(SECRET);
  const input = new Uint8Array(secretBytes.length + salt.length);
  input.set(secretBytes, 0);
  input.set(salt, secretBytes.length);
  const keyMat = await crypto.subtle.digest("SHA-256", input);
  return crypto.subtle.importKey("raw", keyMat, "AES-CTR", false, ["encrypt", "decrypt"]);
}

// AES-CTR over one segment. `counter` is the 16-byte initial counter block for
// this segment; length:64 means the low 64 bits are the counter (plenty: a file
// would need 2^64 * 16 bytes to wrap).
async function aesCtr(op, key, counter, data) {
  const fn = op === "enc" ? crypto.subtle.encrypt : crypto.subtle.decrypt;
  const buf = await fn.call(crypto.subtle, { name: "AES-CTR", counter, length: 64 }, key, data);
  return new Uint8Array(buf);
}

// Advance a 16-byte counter block by `blocks` AES blocks (big-endian add over
// the low 64 bits, matching WebCrypto's length:64 counter). Returns a new
// Uint8Array; the original is untouched.
function counterAdd(base, blocks) {
  const out = base.slice();
  let carry = BigInt(blocks);
  for (let i = 15; i >= 8 && carry > 0n; i--) {
    const sum = BigInt(out[i]) + (carry & 0xffn);
    out[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return out;
}

// ============================ TINV2 (legacy, full-file) ============================

/**
 * Wrap a raw WebM (Uint8Array) + metadata object into a TINV2 container.
 * Single-blob; downloads fully before playing. Prefer encodeTinvStream.
 */
export async function encodeTinv(webm, meta) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveKey(salt);
  const payload = await aesCtr("enc", key, salt, webm);
  const metaBytes = encoder.encode(JSON.stringify(meta || {}));
  const total = MAGIC2.length + SALT_LEN + 4 + metaBytes.length + payload.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(MAGIC2, off); off += MAGIC2.length;
  out.set(salt, off); off += SALT_LEN;
  out.set(u32le(metaBytes.length), off); off += 4;
  out.set(metaBytes, off); off += metaBytes.length;
  out.set(payload, off);
  return out;
}

// ============================ WebM segmentation ============================

// Walk top-level MP4 boxes. Each box is [uint32 size][4-char type][...]. A size
// of 1 means a 64-bit size follows the type. Returns { type, start, size }.
function readBox(b, off) {
  if (off + 8 > b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset);
  let size = dv.getUint32(off);
  const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
  let headerLen = 8;
  if (size === 1) {
    if (off + 16 > b.length) return null;
    size = Number(dv.getBigUint64(off + 8));
    headerLen = 16;
  } else if (size === 0) {
    size = b.length - off; // extends to EOF
  }
  if (size < headerLen) return null;
  return { type, start: off, size };
}

/**
 * Split a fragmented MP4 (fMP4) into an init segment and media fragments.
 * init = ftyp + moov (everything before the first moof). Each fragment is one
 * moof+mdat pair, which MediaSource appends as an independent media segment.
 * A trailing mfra (random-access index) is folded into the last fragment.
 *
 * Returns { init, clusters } (clusters = fragments) or null if the box layout
 * isn't fMP4 (caller falls back to single-blob TINV2).
 */
export function splitMp4Fragments(mp4) {
  const b = mp4;
  const n = b.length;
  let off = 0;
  let firstMoof = -1;
  const fragStarts = [];

  while (off < n) {
    const box = readBox(b, off);
    if (!box) break;
    if (box.type === "moof") {
      if (firstMoof < 0) firstMoof = box.start;
      fragStarts.push(box.start);
    }
    off = box.start + box.size;
    if (box.size <= 0) break;
  }

  if (firstMoof < 0 || !fragStarts.length) return null;

  const init = b.slice(0, firstMoof);
  const clusters = [];
  for (let i = 0; i < fragStarts.length; i++) {
    const start = fragStarts[i];
    const end = i + 1 < fragStarts.length ? fragStarts[i + 1] : n;
    clusters.push(b.slice(start, end));
  }
  return { init, clusters };
}

// Group fragments into chunks with a RAMPED target size: the first chunk is
// tiny (one fragment ⇒ one keyframe ⇒ enough to start playing) so streaming
// playback begins after the fewest possible bytes, then the target grows
// geometrically toward a cap to keep per-chunk overhead low for the long tail.
// Each chunk still starts on a moof boundary.
const FIRST_CHUNK_BYTES = 48 * 1024;   // first chunk: start playing ASAP
const MAX_CHUNK_BYTES = 512 * 1024;    // cap for later chunks
const CHUNK_GROWTH = 2;                 // double the target each chunk

function groupClusters(clusters) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  let target = FIRST_CHUNK_BYTES;
  for (const c of clusters) {
    cur.push(c);
    curLen += c.length;
    if (curLen >= target) {
      chunks.push(concat(cur));
      cur = [];
      curLen = 0;
      target = Math.min(MAX_CHUNK_BYTES, target * CHUNK_GROWTH);
    }
  }
  if (cur.length) chunks.push(concat(cur));
  return chunks;
}

function concat(arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ============================ TINV3 (streaming) ============================

/**
 * Wrap a raw WebM into a streaming TINV3 container. Falls back to TINV2 if the
 * WebM can't be split on cluster boundaries (so we always produce a valid file).
 */
export async function encodeTinvStream(webm, meta) {
  const split = splitMp4Fragments(webm);
  if (!split) return encodeTinv(webm, meta);

  const initSeg = split.init;
  const chunks = groupClusters(split.clusters);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveKey(salt);

  // One continuous keystream across [init, chunk0, chunk1, ...]; each segment
  // gets a counter advanced by the plaintext block offset so far.
  const encInit = await aesCtr("enc", key, salt, initSeg);
  let blockOff = Math.ceil(initSeg.length / 16);

  const encChunks = [];
  for (const c of chunks) {
    const ctr = counterAdd(salt, blockOff);
    encChunks.push(await aesCtr("enc", key, ctr, c));
    blockOff += Math.ceil(c.length / 16);
  }

  const fullMeta = Object.assign({}, meta, {
    _tinv: { initLen: initSeg.length, chunkLens: chunks.map((c) => c.length) },
  });
  const metaBytes = encoder.encode(JSON.stringify(fullMeta));

  let payloadLen = encInit.length;
  for (const c of encChunks) payloadLen += c.length;

  const total = MAGIC3.length + SALT_LEN + 4 + metaBytes.length + payloadLen;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(MAGIC3, off); off += MAGIC3.length;
  out.set(salt, off); off += SALT_LEN;
  out.set(u32le(metaBytes.length), off); off += 4;
  out.set(metaBytes, off); off += metaBytes.length;
  out.set(encInit, off); off += encInit.length;
  for (const c of encChunks) { out.set(c, off); off += c.length; }
  return out;
}

// ============================ Header parsing ============================

function parseHeader(bytes) {
  const isV3 = matchMagic(bytes, MAGIC3);
  const isV2 = matchMagic(bytes, MAGIC2);
  if (!isV3 && !isV2) return null;
  let off = (isV3 ? MAGIC3 : MAGIC2).length;
  if (bytes.length < off + SALT_LEN + 4) return null;
  const salt = bytes.slice(off, off + SALT_LEN);
  off += SALT_LEN;
  const metaLen = readU32le(bytes, off);
  off += 4;
  if (bytes.length < off + metaLen) return null;
  const metaBytes = bytes.slice(off, off + metaLen);
  off += metaLen;
  const payload = bytes.slice(off);
  let meta = null;
  try { meta = JSON.parse(new TextDecoder().decode(metaBytes)); } catch (_) {}
  return { version: isV3 ? 3 : 2, salt, meta, payload, payloadOffset: off };
}

/** Parse the embedded metadata from a .tinv byte array (no video decode). */
export function readMetadata(bytes) {
  const h = parseHeader(bytes);
  if (!h || !h.meta) return null;
  const m = Object.assign({}, h.meta);
  delete m._tinv; // internal segment table — not user metadata
  return m;
}

// ============================ Full decode (Blob) ============================

/**
 * Decode a .tinv byte array into a playable WebM Blob (+ metadata). Works for
 * both TINV2 and TINV3 (TINV3 is decrypted segment-by-segment then joined).
 * Use this when you can't stream (extension, unsupported MediaSource, etc.).
 * Returns { blob, meta } or null.
 */
export async function decodeTinv(bytes) {
  const h = parseHeader(bytes);
  if (!h) return null;
  const key = await deriveKey(h.salt);

  let webm;
  if (h.version === 2) {
    webm = await aesCtr("dec", key, h.salt, h.payload);
  } else {
    const seg = h.meta && h.meta._tinv;
    if (!seg) return null;
    const parts = [];
    let p = 0;
    let blockOff = 0;
    const decSeg = async (len) => {
      const ctr = counterAdd(h.salt, blockOff);
      const dec = await aesCtr("dec", key, ctr, h.payload.slice(p, p + len));
      parts.push(dec);
      p += len;
      blockOff += Math.ceil(len / 16);
    };
    await decSeg(seg.initLen);
    for (const len of seg.chunkLens) await decSeg(len);
    webm = concat(parts);
  }

  const meta = h.meta ? Object.assign({}, h.meta) : null;
  if (meta) delete meta._tinv;
  // TINV3 payload is fragmented MP4; legacy TINV2 is WebM.
  const type = h.version === 3 ? "video/mp4" : "video/webm";
  return { blob: new Blob([webm], { type }), meta };
}

// ============================ Streaming decode ============================

/**
 * True if `bytes` (which may be only the file's head) is a streamable TINV3.
 * The caller needs at least the header + metadata to know; pass what you have.
 */
export function isStreamable(bytes) {
  if (!matchMagic(bytes, MAGIC3)) return false;
  const h = parseHeader(bytes);
  return !!(h && h.meta && h.meta._tinv);
}

/**
 * Stream-decode a TINV3 from a fetch Response. Returns:
 *   { meta, codecs, init, next() }
 * where init is the decrypted init-segment Uint8Array, and next() resolves to
 * the next decrypted chunk Uint8Array (or null when done). The caller appends
 * init then each chunk to a MediaSource SourceBuffer.
 *
 * Reads the response body as a stream, so chunks become available as they
 * download. Falls back to throwing if the file isn't TINV3 (caller should then
 * use decodeTinv on the full bytes).
 */
export async function openTinvStream(response, onBytes) {
  const reader = response.body.getReader();
  let buf = new Uint8Array(0);
  let received = 0;
  const total = Number(response.headers.get("content-length")) || 0;

  const pull = async () => {
    const { value, done } = await reader.read();
    if (done) return false;
    received += value.length;
    if (onBytes) onBytes(received, total);
    const merged = new Uint8Array(buf.length + value.length);
    merged.set(buf, 0);
    merged.set(value, buf.length);
    buf = merged;
    return true;
  };

  // Read until we have the full header (magic+salt+metaLen+meta). metaLen tells
  // us how far that is; loop until buf covers it.
  const headFixed = MAGIC3.length + SALT_LEN + 4;
  while (buf.length < headFixed) if (!(await pull())) throw new Error("truncated tinv header");
  if (!matchMagic(buf, MAGIC3)) throw new Error("not a TINV3 stream");
  const metaLen = readU32le(buf, MAGIC3.length + SALT_LEN);
  const headerEnd = headFixed + metaLen;
  while (buf.length < headerEnd) if (!(await pull())) throw new Error("truncated tinv metadata");

  const salt = buf.slice(MAGIC3.length, MAGIC3.length + SALT_LEN);
  const meta = JSON.parse(new TextDecoder().decode(buf.slice(headFixed, headerEnd)));
  const seg = meta._tinv;
  if (!seg) throw new Error("TINV3 missing segment table");

  const key = await deriveKey(salt);
  let payloadPos = 0; // bytes of payload consumed (plaintext == ciphertext len)
  let blockOff = 0;
  let cursor = headerEnd; // absolute position in buf where unread payload begins

  // Ensure buf has at least `len` payload bytes available from `cursor`.
  const ensure = async (len) => {
    while (buf.length - cursor < len) if (!(await pull())) throw new Error("truncated tinv payload");
  };

  const takeSegment = async (len) => {
    await ensure(len);
    const slice = buf.slice(cursor, cursor + len);
    cursor += len;
    const ctr = counterAdd(salt, blockOff);
    const dec = await aesCtr("dec", key, ctr, slice);
    payloadPos += len;
    blockOff += Math.ceil(len / 16);
    return dec;
  };

  const init = await takeSegment(seg.initLen);

  let chunkIdx = 0;
  const next = async () => {
    if (chunkIdx >= seg.chunkLens.length) return null;
    const len = seg.chunkLens[chunkIdx++];
    return takeSegment(len);
  };

  const cleanMeta = Object.assign({}, meta);
  delete cleanMeta._tinv;

  return { meta: cleanMeta, init, next, chunkCount: seg.chunkLens.length };
}
