// Extension player — auto-plays. It loads a .tinv from the `?url=` param set
// when the extension redirects a .tinv web link. The manual drop UI is only a
// fallback if the page is opened bare.

import { TinvPlayer, collectEls } from "./player-core.js";

const els = collectEls();
const player = new TinvPlayer(els, { onStatus: handleStatus });

let _lastUrl = null;

// Loading / error feedback. The extension auto-plays remote links, so silent
// failure (bad URL, CORS, corrupt) is the worst case — surface it.
function handleStatus(state, info) {
  const view = document.getElementById("status-view");
  const dz = document.getElementById("dropzone");
  const pw = document.getElementById("player-wrapper");
  const eyebrow = document.getElementById("status-eyebrow");
  const title = document.getElementById("status-title");
  const prog = document.getElementById("status-progress");
  const fill = document.getElementById("status-bar-fill");
  const bytes = document.getElementById("status-bytes");
  const actions = document.getElementById("status-actions");
  if (!view) return;
  const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

  if (state === "loading") {
    if (pw && !pw.hidden && info.phase === "streaming") return; // already playing
    view.hidden = false;
    if (dz) dz.hidden = true;
    if (pw) pw.hidden = true;
    if (actions) actions.hidden = true;
    eyebrow.textContent = "LOADING";
    const phases = { connecting: "Connecting…", reading: "Reading file…", downloading: "Downloading…", streaming: "Buffering…" };
    title.textContent = phases[info.phase] || "Opening video…";
    if ((info.phase === "downloading" || info.phase === "streaming") && info.total) {
      prog.hidden = false;
      fill.style.width = `${Math.min(100, Math.round((info.received / info.total) * 100))}%`;
      bytes.textContent = `${mb(info.received)} / ${mb(info.total)}`;
    } else {
      prog.hidden = true;
    }
  } else if (state === "ready") {
    view.hidden = true;
  } else if (state === "error") {
    view.hidden = false;
    if (dz) dz.hidden = true;
    if (pw) pw.hidden = true;
    eyebrow.textContent = "COULDN’T PLAY";
    title.textContent = info.message || "Something went wrong opening this video.";
    prog.hidden = true;
    if (actions) actions.hidden = false;
  }
}

document.getElementById("status-file-input")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) player.loadFile(file);
});

// Web links: ?url=<the .tinv address>
const params = new URLSearchParams(location.search);
const url = params.get("url");
if (url) {
  try {
    const u = new URL(url, location.href);
    if (u.protocol === "http:" || u.protocol === "https:") {
      _lastUrl = u.href;
      player.loadUrl(u.href);
    }
  } catch (_) {/* fall through to the picker */}
}

// Fallback drop/picker — only used if nothing auto-loaded.
const fileInput = document.getElementById("file-input");
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) player.loadFile(file);
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
  if (file) player.loadFile(file);
});

// Swap files by dropping onto the player.
const wrap = document.getElementById("player-wrapper");
wrap?.addEventListener("dragover", (e) => e.preventDefault());
wrap?.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) player.loadFile(file);
});
