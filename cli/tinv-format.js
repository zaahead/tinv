// tinv container format — CLI encoder (standalone).
//
// This is the LOCAL pipeline's own copy of the encoder. It deliberately does
// NOT import from ../web: the CLI is an independent pipeline. What it shares
// with the web app and extension is the OUTPUT, not the code.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ WIRE-COMPATIBLE CONTRACT                                                  │
// │ The bytes produced here MUST stay identical to web/tinv-format.js so a    │
// │ .tinv file made by this CLI plays in the web app and the extension.       │
// │ If you change the container layout, AES scheme, SECRET, or segment table  │
// │ here, mirror it in web/tinv-format.js (and the players) — otherwise CLI   │
// │ output stops interoperating. This file is encoder-only; the decode/       │
// │ streaming half lives with the players.                                    │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Container layout (TINV3, streaming; little-endian):
//   magic     5    "TINV3"
//   salt      16   random per file (base AES-CTR counter block)
//   metaLen   4    uint32, length of the JSON metadata
//   metadata       UTF-8 JSON, carries meta._tinv = { initLen, chunkLens:[...] }
//   initSeg        AES-CTR(ftyp + moov)
//   chunk[0..n]    AES-CTR(one or more moof+mdat fragments each)
// Key = SHA-256(SECRET ‖ salt). Base counter = the 16-byte salt; segments share
// one continuous keystream (counter advanced by the plaintext block offset).

const MAGIC2 = [0x54, 0x49, 0x4e, 0x56, 0x32]; // "TINV2"
const MAGIC3 = [0x54, 0x49, 0x4e, 0x56, 0x33]; // "TINV3"
const SALT_LEN = 16;
const SECRET = "tinv-v1-7Qm2pX9sLraF0bKzVtNcUeWdHgYjBoIw";

const encoder = new TextEncoder();

function u32le(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

async function deriveKey(salt) {
  const secretBytes = encoder.encode(SECRET);
  const input = new Uint8Array(secretBytes.length + salt.length);
  input.set(secretBytes, 0);
  input.set(salt, secretBytes.length);
  const keyMat = await crypto.subtle.digest("SHA-256", input);
  return crypto.subtle.importKey("raw", keyMat, "AES-CTR", false, ["encrypt", "decrypt"]);
}

// AES-CTR over one segment. `counter` is the 16-byte initial counter block;
// length:64 means the low 64 bits are the counter (a file would need 2^64 * 16
// bytes to wrap).
async function aesCtr(op, key, counter, data) {
  const fn = op === "enc" ? crypto.subtle.encrypt : crypto.subtle.decrypt;
  const buf = await fn.call(crypto.subtle, { name: "AES-CTR", counter, length: 64 }, key, data);
  return new Uint8Array(buf);
}

// Advance a 16-byte counter block by `blocks` AES blocks (big-endian add over
// the low 64 bits, matching WebCrypto's length:64 counter).
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

// ---- fragmented-MP4 segmentation ----

// Walk top-level MP4 boxes: [uint32 size][4-char type][...]. size 1 ⇒ 64-bit
// size follows the type; size 0 ⇒ extends to EOF. Returns { type, start, size }.
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
    size = b.length - off;
  }
  if (size < headerLen) return null;
  return { type, start: off, size };
}

// Split fMP4 into an init segment (ftyp + moov, everything before the first
// moof) and N media fragments (one moof+mdat pair each). Returns
// { init, clusters } or null if the layout isn't fMP4.
function splitMp4Fragments(mp4) {
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

// Group fragments into chunks with a ramped target size: the first chunk is tiny
// (one keyframe ⇒ start playing ASAP), then the target grows geometrically to a
// cap. Each chunk starts on a moof boundary.
const FIRST_CHUNK_BYTES = 48 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const CHUNK_GROWTH = 2;

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

// ---- TINV2 (legacy, full-file fallback) ----

async function encodeTinv(webm, meta) {
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

// ---- TINV3 (streaming) ----

/**
 * Wrap a fragmented-MP4 byte array into a streaming TINV3 container. Falls back
 * to TINV2 if the input can't be split on moof boundaries.
 */
export async function encodeTinvStream(mp4, meta) {
  const split = splitMp4Fragments(mp4);
  if (!split) return encodeTinv(mp4, meta);

  const initSeg = split.init;
  const chunks = groupClusters(split.clusters);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveKey(salt);

  // One continuous keystream across [init, chunk0, chunk1, ...]; each segment's
  // counter is advanced by the plaintext block offset so far.
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
