// PWA shell: wires the shared TinvPlayer to the page, handles drag-drop,
// the file picker, remote ?url= loading, embedded metadata (chapters/title),
// the install prompt, and service-worker registration.

import { TinvPlayer, collectEls, formatTime } from "./player-core.js";
import { checkSupport } from "./compat.js";

const els = collectEls();
// Metadata is embedded inside the .tinv container; the player hands it back
// here when a file loads (no sidecar fetch needed). onStatus drives the
// loading / error UI while a (possibly remote, streaming) .tinv opens.
const player = new TinvPlayer(els, {
  onMetadata: applyMetadata,
  onStatus: handleStatus,
});

let _lastLoad = null; // remember the last load so "Try again" can retry it.

function handleStatus(state, info) {
  const view = document.getElementById("status-view");
  const dz = document.getElementById("dropzone");
  const pw = document.getElementById("player-wrapper");
  const title = document.getElementById("status-title");
  const eyebrow = document.getElementById("status-eyebrow");
  const prog = document.getElementById("status-progress");
  const fill = document.getElementById("status-bar-fill");
  const bytes = document.getElementById("status-bytes");
  const actions = document.getElementById("status-actions");
  if (!view) return;

  const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

  if (state === "loading") {
    // Don't cover an already-playing video (background chunk feeding).
    if (pw && !pw.hidden && info.phase === "streaming") return;
    view.hidden = false;
    if (dz) dz.hidden = true;
    if (pw) pw.hidden = true;
    actions.hidden = true;
    eyebrow.textContent = "LOADING";
    const phases = {
      connecting: "Connecting…",
      reading: "Reading file…",
      downloading: "Downloading…",
      streaming: "Buffering…",
    };
    title.textContent = phases[info.phase] || "Opening video…";
    if ((info.phase === "downloading" || info.phase === "streaming") && info.total) {
      prog.hidden = false;
      fill.style.width = `${Math.min(100, Math.round((info.received / info.total) * 100))}%`;
      bytes.textContent = `${mb(info.received)} / ${mb(info.total)}`;
    } else if (info.received) {
      prog.hidden = false;
      fill.style.width = "0%";
      fill.classList.add("indeterminate");
      bytes.textContent = mb(info.received);
    } else {
      prog.hidden = true;
    }
  } else if (state === "ready") {
    fill?.classList.remove("indeterminate");
    view.hidden = true;
    maybeShowKbdHint();
  } else if (state === "error") {
    fill?.classList.remove("indeterminate");
    view.hidden = false;
    if (dz) dz.hidden = true;
    if (pw) pw.hidden = true;
    eyebrow.textContent = "COULDN’T PLAY";
    title.textContent = info.message || "Something went wrong opening this video.";
    prog.hidden = true;
    actions.hidden = false;
  }
}

// Warn (dismissible) if the browser can't decode AV1 / lacks Web Crypto.
showCompatBannerIfNeeded();

function showCompatBannerIfNeeded() {
  const problem = checkSupport();
  if (!problem) return;
  if (sessionStorage.getItem("tinv:compat-dismissed") === "1") return;

  const bar = document.createElement("div");
  bar.className = "compat-banner";
  bar.innerHTML =
    `<span><strong>${problem.title}</strong> ${problem.detail}</span>` +
    `<button class="compat-dismiss" aria-label="Dismiss">✕</button>`;
  bar.querySelector(".compat-dismiss").addEventListener("click", () => {
    sessionStorage.setItem("tinv:compat-dismissed", "1");
    bar.remove();
  });
  document.body.prepend(bar);
}

// ---- First-run keyboard hint (shown once per browser) ----

let _kbdHintShown = false;
function maybeShowKbdHint() {
  if (_kbdHintShown) return;
  _kbdHintShown = true;
  let seen = false;
  try { seen = localStorage.getItem("tinv:kbd-hint-seen") === "1"; } catch (_) {}
  if (seen) return;
  const hint = document.getElementById("kbd-hint");
  if (!hint) return;
  hint.hidden = false;
  const dismiss = () => {
    hint.classList.add("leaving");
    try { localStorage.setItem("tinv:kbd-hint-seen", "1"); } catch (_) {}
    setTimeout(() => { hint.hidden = true; hint.classList.remove("leaving"); }, 300);
  };
  document.getElementById("kbd-hint-close")?.addEventListener("click", dismiss, { once: true });
  setTimeout(dismiss, 5000); // auto-dismiss
}

// ---- Local files: picker + drag-drop ----

const fileInput = document.getElementById("file-input");
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) { _lastLoad = { kind: "file", file }; player.loadFile(file); }
});

// Error-view actions: retry the last load, or open a different file.
document.getElementById("status-retry")?.addEventListener("click", () => {
  if (!_lastLoad) return;
  if (_lastLoad.kind === "file") player.loadFile(_lastLoad.file);
  else if (_lastLoad.kind === "url") player.loadUrl(_lastLoad.url);
});
document.getElementById("status-file-input")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) { _lastLoad = { kind: "file", file }; player.loadFile(file); }
});

const dropzone = document.getElementById("dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dropzone?.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone?.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragging");
  })
);
dropzone?.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) { _lastLoad = { kind: "file", file }; player.loadFile(file); }
});
// Allow dropping a new file onto the player to swap it.
document.getElementById("player-wrapper")?.addEventListener("dragover", (e) => e.preventDefault());
document.getElementById("player-wrapper")?.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) { _lastLoad = { kind: "file", file }; player.loadFile(file); }
});

// ---- Local files opened from the OS (double-click .tinv → installed PWA) ----
// Requires the PWA to be installed; the manifest `file_handlers` entry makes
// the OS launch this page with the file in `window.launchQueue`.

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || !launchParams.files.length) return;
    try {
      const file = await launchParams.files[0].getFile();
      _lastLoad = { kind: "file", file };
      player.loadFile(file);
    } catch (_) {/* ignore */}
  });
}

// ---- Remote loading via ?url= ----

const params = new URLSearchParams(location.search);
const remoteUrl = params.get("url");
const isEmbed =
  params.get("embed") === "1" ||
  location.pathname.endsWith("/embed") ||
  document.body.dataset.embed === "1";

if (isEmbed) document.body.classList.add("embed");

if (remoteUrl) {
  try {
    const u = new URL(remoteUrl, location.href);
    if (u.protocol === "http:" || u.protocol === "https:") {
      // Metadata is embedded in the .tinv and surfaced via onMetadata.
      _lastLoad = { kind: "url", url: u.href };
      player.loadUrl(u.href);
    } else {
      showError("Unsupported URL scheme.");
    }
  } catch (_) {
    showError("Invalid ?url= parameter.");
  }
}

// ---- Metadata (embedded in the .tinv container) ----

function applyMetadata(meta) {
  // Title goes to the tab title and the meta strip below the player — not the
  // header (it crowded the links there). The strip is populated just below.
  if (meta.title) document.title = `${meta.title} · tinv`;

  // Populate the editorial meta strip below the player.
  const strip = document.getElementById("meta-strip");
  if (strip) {
    const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("meta-file", (meta.title || "video") + ".tinv");
    set("meta-size", meta.encodedSizeBytes ? mb(meta.encodedSizeBytes) : "—");
    set("meta-ratio",
      meta.encodedSizeBytes && meta.sourceSizeBytes
        ? `${(meta.sourceSizeBytes / meta.encodedSizeBytes).toFixed(0)}× smaller`
        : "—");
    set("meta-author", meta.author || "—");
    strip.hidden = false;
  }

  if (Array.isArray(meta.chapters) && meta.chapters.length) {
    renderChapters(meta.chapters);
  }
}

function renderChapters(chapters) {
  let panel = document.getElementById("chapter-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "chapter-panel";
    panel.className = "chapter-panel";
    document.querySelector(".video-stage")?.appendChild(panel);
  }
  panel.innerHTML =
    `<div class="chapter-title">Chapters</div>` +
    chapters
      .map(
        (c) =>
          `<button class="chapter-item" data-start="${c.startSec}">` +
          `<span class="chapter-time">${formatTime(c.startSec)}</span>` +
          `<span class="chapter-name">${escapeHtml(c.title)}</span></button>`
      )
      .join("");
  panel.querySelectorAll(".chapter-item").forEach((b) =>
    b.addEventListener("click", () => {
      els.video.currentTime = parseFloat(b.dataset.start);
      els.video.play();
    })
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function showError(msg) {
  const sub = document.querySelector(".drop-subtext");
  if (sub) {
    sub.textContent = msg;
    sub.style.color = "#ff6b6b";
  }
}

// ---- PWA install prompt (Phase 4.3) ----

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.createElement("button");
  btn.className = "install-btn";
  btn.textContent = "Install app";
  btn.addEventListener("click", async () => {
    btn.remove();
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  });
  document.querySelector(".header-actions")?.prepend(btn);
});

// ---- Convert view (in-browser encoding) ----

const navPlay = document.getElementById("nav-play");
const navConvert = document.getElementById("nav-convert");
const convertView = document.getElementById("convert-view");
const playerMain = document.getElementById("player-wrapper");
const dropMain = document.getElementById("dropzone");
const statusMain = document.getElementById("status-view");

// A video is "loaded" once the player wrapper has been shown; the player core
// owns that state, so reading its `hidden` flag tells us whether to restore the
// player (vs the dropzone) when the user comes back to the Play view.
function isVideoLoaded() {
  return playerMain && !!player.video?.currentSrc;
}
// A load is in flight / errored if the status view is currently showing.
function isStatusShowing() {
  return statusMain && !statusMain.hidden;
}

function showView(which) {
  const conv = which === "convert";
  convertView.hidden = !conv;
  if (conv) {
    // Hide Play's surfaces, but don't tear down the loaded video — it stays in
    // the DOM (paused) so switching back resumes exactly where it was.
    playerMain.hidden = true;
    dropMain.hidden = true;
    if (statusMain) statusMain.hidden = true;
  } else {
    // Returning to Play: prefer an in-flight/error status, then a loaded player,
    // else the dropzone.
    const status = isStatusShowing();
    const loaded = !status && isVideoLoaded();
    if (statusMain) statusMain.hidden = !status;
    playerMain.hidden = status || !loaded;
    dropMain.hidden = status || loaded;
  }
  navPlay?.classList.toggle("active", !conv);
  navConvert?.classList.toggle("active", conv);
}
navPlay?.addEventListener("click", () => showView("play"));
navConvert?.addEventListener("click", () => { showView("convert"); initConvert(); });

// When the player is closed, restore the default tab title (the video title is
// no longer relevant). Core handles showing the dropzone.
document.getElementById("close-video-btn")?.addEventListener("click", () => {
  document.title = "tinv — tiny video converter & player";
});

let _convertReady = false;
let _convertFile = null;

async function initConvert() {
  if (_convertReady) return;
  _convertReady = true;
  const mod = await import("./convert.js");

  // Gate: in-browser AV1 conversion needs WebCodecs AV1 (Chromium today).
  const support = await mod.isConvertSupported();
  if (!support.ok) {
    const view = document.getElementById("convert-view");
    const aside = view.querySelector(".split-side");
    const messages = {
      "no-webcodecs": "Your browser doesn't support in-browser video encoding.",
      "no-rvfc": "Your browser is missing a feature needed for frame-accurate encoding.",
      "no-av1": "Your browser can't encode AV1 video.",
    };
    if (aside) {
      aside.innerHTML =
        `<div class="convert-unsupported">` +
        `<p class="cu-title">${messages[support.reason] || "In-browser conversion isn't available here."}</p>` +
        `<p class="cu-body">Converting to <code>.tinv</code> in the browser uses native AV1 encoding, ` +
        `currently available in Chromium browsers — <strong>Chrome, Edge, Brave, or Arc</strong>. ` +
        `For any browser and much faster encoding of large files, use the desktop converter.</p>` +
        `</div>`;
    }
    return;
  }

  const sel = document.getElementById("convert-preset");
  for (const [key, p] of Object.entries(mod.PRESETS)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = p.label;
    sel.appendChild(o);
  }

  const input = document.getElementById("convert-input");
  const pickLabel = document.getElementById("convert-pick-label");
  const startBtn = document.getElementById("convert-start");
  const presetSel = document.getElementById("convert-preset");
  let _convertDuration = 0;

  input.addEventListener("change", async (e) => {
    _convertFile = e.target.files[0] || null;
    pickLabel.textContent = _convertFile ? _convertFile.name : "Choose video…";
    startBtn.disabled = !_convertFile;
    _convertDuration = _convertFile ? await probeDuration(_convertFile) : 0;
    updateEstimate(mod.PRESETS, presetSel.value, _convertDuration, _convertFile);
  });
  presetSel.addEventListener("change", () =>
    updateEstimate(mod.PRESETS, presetSel.value, _convertDuration, _convertFile)
  );

  startBtn.addEventListener("click", runConvert);
}

// Read a video file's duration (seconds) without decoding it fully.
function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); v.removeAttribute("src"); resolve(d); };
    v.addEventListener("loadedmetadata", () => done(isFinite(v.duration) ? v.duration : 0), { once: true });
    v.addEventListener("error", () => done(0), { once: true });
    v.src = url;
  });
}

// Rough output-size estimate: (video bitrate + ~24kbps audio) × duration.
// Real size varies with content; this gives an order-of-magnitude expectation.
function updateEstimate(presets, presetKey, duration, file) {
  const row = document.getElementById("convert-estimate-row");
  const out = document.getElementById("convert-estimate");
  if (!row || !out) return;
  if (!file || !duration) { row.hidden = true; return; }
  const p = presets[presetKey] || Object.values(presets)[0];
  const estBytes = ((p.bitrate + 24000) * duration) / 8;
  const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
  const ratio = file.size ? (file.size / estBytes) : 0;
  out.textContent =
    `~${mb(estBytes)}` + (ratio >= 1.2 ? `  ·  ~${ratio.toFixed(0)}× smaller` : "");
  row.hidden = false;
}

async function runConvert() {
  if (!_convertFile) return;
  const { convertFileToTinv } = await import("./convert.js");
  const startBtn = document.getElementById("convert-start");
  const wrap = document.getElementById("convert-progress-wrap");
  const fill = document.getElementById("convert-progress-fill");
  const status = document.getElementById("convert-status");
  const result = document.getElementById("convert-result");

  startBtn.disabled = true;
  result.hidden = true;
  wrap.hidden = false;
  fill.style.width = "0%";
  status.textContent = "Preparing…";

  try {
    const preset = document.getElementById("convert-preset").value;
    const cap1080 = document.getElementById("convert-cap").checked;
    const out = await convertFileToTinv(_convertFile, {
      preset,
      cap1080,
      onStage: (s) => { status.textContent = s; },
      onProgress: (p) => {
        fill.style.width = `${Math.round(p * 100)}%`;
        status.textContent = `Encoding… ${Math.round(p * 100)}%`;
      },
    });

    const blob = new Blob([out.bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";
    const ratio = out.meta.encodedSizeBytes
      ? (out.meta.sourceSizeBytes / out.meta.encodedSizeBytes).toFixed(1)
      : "?";
    result.innerHTML =
      `<div class="convert-done">✓ ${mb(out.meta.sourceSizeBytes)} → ${mb(out.bytes.length)} (${ratio}× smaller)</div>`;
    const dl = document.createElement("a");
    dl.href = url;
    dl.download = out.name;
    dl.className = "btn btn-primary";
    dl.textContent = `Download ${out.name}`;
    result.appendChild(dl);

    result.hidden = false;
    status.textContent = "Done.";
  } catch (e) {
    status.textContent = `Failed: ${e.message || e}. For large files, the desktop converter is faster and more robust.`;
  } finally {
    startBtn.disabled = false;
  }
}

// ---- Service worker (offline shell) ----
// Skip on localhost so dev changes always load fresh (no cache to fight).

const isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

if ("serviceWorker" in navigator && !isEmbed && !isLocalDev) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {/* offline mode unavailable */});
  });
}
