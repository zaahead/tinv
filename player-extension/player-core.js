// Shared player logic for the tinv PWA and the Chrome extension.
//
// A .tinv file is an OBFUSCATED container (see tinv-format.js), not a raw WebM —
// a plain <video> can't play it. This controller reads the bytes, decodes them
// to a real WebM Blob, then drives a <video> with the custom control DOM
// defined in index.html / player.html.
//
// Exposes a single class. Both shells (PWA, extension) instantiate it with the
// same DOM ids, so the controls behave identically everywhere.

import { isTinv, decodeTinv, isStreamable, openTinvStream } from "./tinv-format.js";

// MediaSource MIME for the fragmented MP4 we produce (AV1 video + Opus audio).
// fMP4 is used because browser MediaSource reliably accepts AV1-in-MP4 but not
// AV1 in WebM clusters. We probe a few AV1 levels; if none match we fall back
// to the non-streaming Blob path (which lets the browser sniff the codec).
const MSE_MIME_CANDIDATES = [
  'video/mp4; codecs="av01.0.05M.08, opus"',
  'video/mp4; codecs="av01.0.08M.08, opus"',
  'video/mp4; codecs="av01.0.04M.08, opus"',
  'video/mp4; codecs="av01.0.13M.08, opus"',
  'video/mp4; codecs="av01.0.05M.08"',
];

function pickMseMime() {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) return null;
  for (const m of MSE_MIME_CANDIDATES) if (MediaSource.isTypeSupported(m)) return m;
  return null;
}

export const SPEED_STEPS = [0.5, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

/** Format seconds as M:SS or H:MM:SS. */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Stable-ish key for resume position: name + size avoids collisions cheaply. */
function resumeKey(id) {
  return `tinv:resume:${id}`;
}

export class TinvPlayer {
  /**
   * @param {Object} els  Map of DOM elements (see index.html ids).
   * @param {Object} [opts]
   * @param {Storage} [opts.storage]  Defaults to localStorage; pass null to disable resume.
   */
  constructor(els, opts = {}) {
    this.els = els;
    this.video = els.video;
    this.storage = opts.storage === undefined ? window.localStorage : opts.storage;
    this.resumeId = null;
    this.controlsHideTimer = null;
    // Optional callback(meta) fired when a .tinv's embedded metadata is read.
    this.onMetadata = opts.onMetadata || null;
    // Optional callback(state, info) fired during load. state is one of
    // "loading" ({phase, received, total}), "ready", or "error" ({message}).
    this.onStatus = opts.onStatus || null;
    this._mediaSourceUrl = null;

    this._bindVideoEvents();
    this._bindControls();
    this._bindKeyboard();
  }

  // ---- Loading ----
  //
  // A .tinv is an obfuscated container, NOT a raw WebM — a plain <video> can't
  // read it. We fetch/read the bytes, decode to a real WebM Blob, then play.
  // Non-.tinv inputs play directly. `onMetadata(meta)` fires with embedded
  // metadata when present (used by the PWA for chapters / title).

  _status(state, info) {
    if (this.onStatus) this.onStatus(state, info || {});
  }

  /** Play a local File (drag-drop or picker). */
  async loadFile(file) {
    if (!file) return;
    this.resumeId = `${file.name}:${file.size}`;
    this._status("loading", { phase: "reading" });
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (isTinv(buf)) {
        const decoded = await decodeTinv(buf);
        if (!decoded) throw new Error("This .tinv file is corrupted or incomplete.");
        if (decoded.meta && this.onMetadata) this.onMetadata(decoded.meta);
        const url = URL.createObjectURL(decoded.blob);
        this._setObjectUrl(url);
        this._load(url, (decoded.meta && decoded.meta.title) || file.name);
      } else {
        // A plain video the user dropped — play it directly.
        const url = URL.createObjectURL(file);
        this._setObjectUrl(url);
        this._load(url, file.name);
      }
      this._status("ready");
    } catch (e) {
      this._status("error", { message: e.message || "Couldn't open this file." });
    }
  }

  /** Play a remote URL (?url=...). Streams TINV3 when possible. */
  async loadUrl(url, displayName) {
    this.resumeId = url;
    const name = displayName || url.split("/").pop() || "tinv video";
    this._status("loading", { phase: "connecting" });

    let res;
    try {
      res = await fetch(url, { mode: "cors" });
    } catch (_) {
      this._status("error", {
        message: "Couldn't reach this video. Check the link, your connection, " +
          "or that the host allows cross-origin requests (CORS).",
      });
      return;
    }
    if (!res.ok) {
      this._status("error", { message: `The host returned ${res.status} for this video.` });
      return;
    }

    // Try the streaming path first (TINV3 + MediaSource). If the body turns out
    // not to be a streamable TINV3, we re-fetch for the full-decode fallback —
    // the streaming attempt may have already consumed part of the body.
    const mseMime = pickMseMime();
    if (mseMime) {
      try {
        const streamed = await this._tryStreamUrl(res, name, mseMime);
        if (streamed) { this._status("ready"); return; }
      } catch (_) {
        // Stream attempt failed mid-way — fall through to a clean re-fetch.
      }
      try {
        res = await fetch(url, { mode: "cors" });
        if (!res.ok) throw new Error(`The host returned ${res.status} for this video.`);
      } catch (e) {
        this._status("error", { message: e.message || "Couldn't load this video." });
        return;
      }
    }

    // Non-streaming path: download fully, then decode to a Blob.
    try {
      const buf = await this._downloadWithProgress(res, url);
      if (isTinv(buf)) {
        const decoded = await decodeTinv(buf);
        if (!decoded) throw new Error("This .tinv file is corrupted or incomplete.");
        if (decoded.meta && this.onMetadata) this.onMetadata(decoded.meta);
        const objUrl = URL.createObjectURL(decoded.blob);
        this._setObjectUrl(objUrl);
        this._load(objUrl, (decoded.meta && decoded.meta.title) || name);
      } else {
        // Not a tinv container — let <video> fetch it directly.
        this._setObjectUrl(null);
        this._load(url, name);
      }
      this._status("ready");
    } catch (e) {
      this._status("error", { message: e.message || "Couldn't load this video." });
    }
  }

  // Stream a TINV3 response through MediaSource so playback starts after the
  // init segment + first chunk. Returns true on success, false if the response
  // isn't a streamable TINV3 (caller should fall back to full decode).
  async _tryStreamUrl(res, name, mime) {
    let stream;
    try {
      stream = await openTinvStream(res, (received, total) => {
        this._status("loading", { phase: "streaming", received, total });
      });
    } catch (_) {
      // Not a streamable TINV3 (legacy TINV2 or non-tinv). Caller re-fetches
      // for the full-decode fallback.
      return false;
    }

    if (stream.meta && this.onMetadata) this.onMetadata(stream.meta);

    const ms = new MediaSource();
    const objUrl = URL.createObjectURL(ms);
    this._setMediaSource(objUrl);

    // Attach the MediaSource to the <video> NOW so the element shows and the
    // "sourceopen" event fires. We resolve once the init segment + first chunk
    // are buffered (enough to start playing); the rest is fed in the background.
    this._load(objUrl, (stream.meta && stream.meta.title) || name);

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      const ok = () => { if (!settled) { settled = true; resolve(); } };

      const onOpen = async () => {
        let sb;
        try {
          sb = ms.addSourceBuffer(mime);
        } catch (e) { fail(e); return; }

        const appendBuffer = (bytes) =>
          new Promise((res2, rej2) => {
            const onDone = () => { sb.removeEventListener("error", onErr); res2(); };
            const onErr = () => { sb.removeEventListener("updateend", onDone); rej2(new Error("append failed")); };
            sb.addEventListener("updateend", onDone, { once: true });
            sb.addEventListener("error", onErr, { once: true });
            sb.appendBuffer(bytes);
          });

        try {
          await appendBuffer(stream.init);
          let chunk;
          let first = true;
          while ((chunk = await stream.next()) !== null) {
            await appendBuffer(chunk);
            if (first) { first = false; ok(); } // enough to start; keep feeding
          }
          if (first) ok(); // single-chunk file
          if (ms.readyState === "open") ms.endOfStream();
        } catch (e) {
          if (ms.readyState === "open") { try { ms.endOfStream("decode"); } catch (_) {} }
          fail(e);
        }
      };

      if (ms.readyState === "open") onOpen();
      else ms.addEventListener("sourceopen", onOpen, { once: true });
    });

    return true;
  }

  // Download a Response fully while reporting byte progress.
  async _downloadWithProgress(res, _url) {
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !res.body.getReader) {
      return new Uint8Array(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      this._status("loading", { phase: "downloading", received, total });
    }
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  _setMediaSource(url) {
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    if (this._mediaSourceUrl) URL.revokeObjectURL(this._mediaSourceUrl);
    this._mediaSourceUrl = url;
  }

  _setObjectUrl(url) {
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = url;
  }

  _objectUrlFor() {/* placeholder kept for signature compatibility */}

  _load(src, name) {
    this.video.src = src;
    if (this.els.filename) this.els.filename.textContent = name;
    this._show(this.els.playerWrapper);
    this._hide(this.els.dropzone);
    this._applyPrefs();
    // Skeleton shimmer on the video frame until the first frame is decodable.
    const stage = this.els.stage || this.els.playerWrapper;
    stage?.classList.add("is-loading");
    const clearSkeleton = () => stage?.classList.remove("is-loading");
    this.video.addEventListener("loadeddata", clearSkeleton, { once: true });
    this.video.addEventListener("error", clearSkeleton, { once: true });
    // Resume position. With MediaSource the duration may be unknown at
    // loadedmetadata, so try at both loadedmetadata and durationchange; restore
    // at most once (the flag guards re-entry).
    this._resumeDone = false;
    const tryResume = () => {
      if (this._resumeDone) return;
      if (this._restoreResume()) this._resumeDone = true;
    };
    this.video.addEventListener("loadedmetadata", tryResume);
    this.video.addEventListener("durationchange", tryResume);
    this.video.addEventListener("loadeddata", tryResume);
    this.video.play().catch(() => {/* user can press play */});
  }

  close() {
    this._saveResume();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = null;
    }
    if (this._mediaSourceUrl) {
      URL.revokeObjectURL(this._mediaSourceUrl);
      this._mediaSourceUrl = null;
    }
    this._hide(this.els.playerWrapper);
    this._show(this.els.dropzone);
  }

  // ---- Resume position ----

  _saveResume() {
    if (!this.storage || !this.resumeId) return;
    const t = this.video.currentTime;
    // Don't bother for the first/last few seconds.
    if (t > 5 && t < this.video.duration - 5) {
      try { this.storage.setItem(resumeKey(this.resumeId), String(t)); } catch (_) {}
    } else {
      try { this.storage.removeItem(resumeKey(this.resumeId)); } catch (_) {}
    }
  }

  // Returns true once it has applied (or decided there's nothing) so the caller
  // can stop retrying; returns false if duration isn't known yet (retry later).
  _restoreResume() {
    if (!this.storage || !this.resumeId) return true;
    try {
      const saved = parseFloat(this.storage.getItem(resumeKey(this.resumeId)));
      if (!(saved > 0)) return true; // nothing saved
      const dur = this.video.duration;
      if (!isFinite(dur) || dur <= 0) return false; // duration unknown yet
      if (saved < dur - 1) this.video.currentTime = saved;
      return true;
    } catch (_) {
      return true;
    }
  }

  // ---- Playback ----

  togglePlay() {
    if (this.video.paused) this.video.play(); else this.video.pause();
  }

  seekBy(delta) {
    this.video.currentTime = Math.max(
      0,
      Math.min(this.video.duration || 0, this.video.currentTime + delta)
    );
  }

  setSpeed(rate) {
    this.video.playbackRate = rate;
    if (this.els.speedBtn) this.els.speedBtn.textContent = `${rate.toFixed(2).replace(/\.?0+$/, "")}x`;
    if (this.els.speedOptions) {
      this.els.speedOptions.forEach((b) =>
        b.classList.toggle("active", parseFloat(b.dataset.speed) === rate)
      );
    }
    this._savePref("speed", rate);
  }

  stepSpeed(dir) {
    const i = SPEED_STEPS.indexOf(this.video.playbackRate);
    const next = SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, (i < 0 ? 2 : i) + dir))];
    this.setSpeed(next);
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    this._syncVolumeUi();
  }

  setVolume(v) {
    this.video.volume = v;
    this.video.muted = v === 0;
    this._syncVolumeUi();
    this._savePref("volume", v);
  }

  // ---- Persisted preferences (volume, speed) — global, not per-file ----

  _savePref(key, value) {
    if (!this.storage) return;
    try { this.storage.setItem(`tinv:pref:${key}`, String(value)); } catch (_) {}
  }

  _getPref(key) {
    if (!this.storage) return null;
    try {
      const v = this.storage.getItem(`tinv:pref:${key}`);
      return v == null ? null : parseFloat(v);
    } catch (_) { return null; }
  }

  // Apply saved volume + speed to a freshly loaded video. Speed survives the
  // src change on its own only if reapplied; volume must be set explicitly.
  _applyPrefs() {
    const vol = this._getPref("volume");
    if (vol != null && isFinite(vol)) {
      this.video.volume = vol;
      this.video.muted = vol === 0;
      this._syncVolumeUi();
    }
    const spd = this._getPref("speed");
    if (spd != null && isFinite(spd) && spd > 0) this.setSpeed(spd);
  }

  toggleFullscreen() {
    const stage = this.els.stage || this.els.playerWrapper;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (stage?.requestFullscreen) {
      stage.requestFullscreen();
    }
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (this.video.requestPictureInPicture) {
        await this.video.requestPictureInPicture();
      }
    } catch (_) {/* PiP unsupported or blocked */}
  }

  // ---- Wiring ----

  _bindVideoEvents() {
    const v = this.video;
    v.addEventListener("timeupdate", () => this._renderProgress());
    v.addEventListener("progress", () => this._renderBuffer());
    const updateTotal = () => {
      if (this.els.timeTotal && isFinite(v.duration)) {
        this.els.timeTotal.textContent = formatTime(v.duration);
      }
    };
    // loadedmetadata may fire before MediaSource knows the duration; durationchange
    // (fired when endOfStream sets it) catches the streaming case.
    v.addEventListener("loadedmetadata", updateTotal);
    v.addEventListener("durationchange", updateTotal);
    v.addEventListener("play", () => this._syncPlayUi(true));
    v.addEventListener("pause", () => { this._syncPlayUi(false); this._saveResume(); });
    v.addEventListener("ended", () => { this._syncPlayUi(false); });
    // Persist resume position before the tab unloads.
    window.addEventListener("beforeunload", () => this._saveResume());
    document.addEventListener("fullscreenchange", () => this._syncFullscreenUi());
  }

  _bindControls() {
    const e = this.els;
    e.playBtn?.addEventListener("click", () => this.togglePlay());
    e.centerPlay?.addEventListener("click", () => this.togglePlay());

    // Single click on the video = play/pause; double click = fullscreen.
    // Delay the single-click action so a double-click doesn't also toggle play.
    let clickTimer = null;
    this.video.addEventListener("click", () => {
      if (clickTimer) return; // second click handled by dblclick
      clickTimer = setTimeout(() => {
        clickTimer = null;
        this.togglePlay();
      }, 220);
    });
    this.video.addEventListener("dblclick", () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      this.toggleFullscreen();
    });
    e.skipBack?.addEventListener("click", () => this.seekBy(-10));
    e.skipForward?.addEventListener("click", () => this.seekBy(10));
    e.muteBtn?.addEventListener("click", () => this.toggleMute());
    e.volumeSlider?.addEventListener("input", (ev) => this.setVolume(parseFloat(ev.target.value)));
    e.fullscreenBtn?.addEventListener("click", () => this.toggleFullscreen());
    e.pipBtn?.addEventListener("click", () => this.togglePip());
    e.closeBtn?.addEventListener("click", () => this.close());
    e.speedBtn?.addEventListener("click", () => e.speedMenu?.classList.toggle("open"));
    e.speedOptions?.forEach((b) =>
      b.addEventListener("click", () => {
        this.setSpeed(parseFloat(b.dataset.speed));
        e.speedMenu?.classList.remove("open");
      })
    );

    // Scrub bar: click / drag to seek.
    if (e.progressContainer) {
      const seekFromEvent = (ev) => {
        const rect = e.progressContainer.getBoundingClientRect();
        const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
        const ratio = Math.max(0, Math.min(1, x / rect.width));
        this.video.currentTime = ratio * (this.video.duration || 0);
        if (e.progressTooltip) e.progressTooltip.textContent = formatTime(this.video.currentTime);
      };
      let dragging = false;
      e.progressContainer.addEventListener("mousedown", (ev) => { dragging = true; seekFromEvent(ev); });
      window.addEventListener("mousemove", (ev) => { if (dragging) seekFromEvent(ev); });
      window.addEventListener("mouseup", () => { dragging = false; });
      e.progressContainer.addEventListener("mousemove", (ev) => {
        if (e.progressTooltip) {
          const rect = e.progressContainer.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
          e.progressTooltip.textContent = formatTime(ratio * (this.video.duration || 0));
        }
      });
      e.progressContainer.addEventListener("click", seekFromEvent);
    }

    // Auto-hide controls during playback.
    const wrap = e.playerWrapper;
    if (wrap) {
      ["mousemove", "touchstart"].forEach((ev) =>
        wrap.addEventListener(ev, () => this._wakeControls())
      );
    }
  }

  _bindKeyboard() {
    document.addEventListener("keydown", (ev) => {
      if (ev.target.matches("input, textarea")) return;
      switch (ev.key) {
        case " ": case "k": ev.preventDefault(); this.togglePlay(); break;
        case "ArrowLeft": this.seekBy(-10); break;
        case "ArrowRight": this.seekBy(10); break;
        case "j": this.seekBy(-10); break;
        case "l": this.seekBy(10); break;
        case "ArrowUp": this.setVolume(Math.min(1, this.video.volume + 0.1)); break;
        case "ArrowDown": this.setVolume(Math.max(0, this.video.volume - 0.1)); break;
        case "m": this.toggleMute(); break;
        case "f": this.toggleFullscreen(); break;
        case "p": this.togglePip(); break;
        case ">": case ".": this.stepSpeed(1); break;
        case "<": case ",": this.stepSpeed(-1); break;
      }
    });
  }

  // ---- UI sync ----

  _renderProgress() {
    const v = this.video;
    const pct = v.duration ? (v.currentTime / v.duration) * 100 : 0;
    if (this.els.progressFill) this.els.progressFill.style.width = `${pct}%`;
    if (this.els.timeCurrent) this.els.timeCurrent.textContent = formatTime(v.currentTime);
  }

  _renderBuffer() {
    const v = this.video;
    if (!this.els.progressBuffer || !v.buffered.length || !v.duration) return;
    const end = v.buffered.end(v.buffered.length - 1);
    this.els.progressBuffer.style.width = `${(end / v.duration) * 100}%`;
  }

  _syncPlayUi(playing) {
    if (this.els.playIcon) this.els.playIcon.style.display = playing ? "none" : "";
    if (this.els.pauseIcon) this.els.pauseIcon.style.display = playing ? "" : "none";
    if (this.els.centerPlay) this.els.centerPlay.classList.toggle("visible", !playing);
  }

  _syncVolumeUi() {
    const muted = this.video.muted || this.video.volume === 0;
    if (this.els.volumeHighIcon) this.els.volumeHighIcon.style.display = muted ? "none" : "";
    if (this.els.volumeMuteIcon) this.els.volumeMuteIcon.style.display = muted ? "" : "none";
    if (this.els.volumeSlider) this.els.volumeSlider.value = muted ? 0 : this.video.volume;
  }

  _syncFullscreenUi() {
    const fs = !!document.fullscreenElement;
    if (this.els.fullscreenEnterIcon) this.els.fullscreenEnterIcon.style.display = fs ? "none" : "";
    if (this.els.fullscreenExitIcon) this.els.fullscreenExitIcon.style.display = fs ? "" : "none";
  }

  _wakeControls() {
    this.els.controls?.classList.remove("hidden");
    clearTimeout(this.controlsHideTimer);
    this.controlsHideTimer = setTimeout(() => {
      if (!this.video.paused) this.els.controls?.classList.add("hidden");
    }, 2600);
  }

  // ---- Small DOM helpers ----

  _show(el) { if (el) el.hidden = false; }
  _hide(el) { if (el) el.hidden = true; }
}

/** Collect the standard tinv control elements from `document`. */
export function collectEls(doc = document) {
  const $ = (id) => doc.getElementById(id);
  return {
    video: $("video-element"),
    dropzone: $("dropzone"),
    playerWrapper: $("player-wrapper"),
    stage: doc.querySelector(".video-stage"),
    controls: $("custom-controls"),
    filename: $("video-filename"),
    closeBtn: $("close-video-btn"),
    centerPlay: $("center-play-indicator"),
    playBtn: $("play-pause-btn"),
    playIcon: $("play-icon"),
    pauseIcon: $("pause-icon"),
    skipBack: $("skip-back-btn"),
    skipForward: $("skip-forward-btn"),
    timeCurrent: $("time-current"),
    timeTotal: $("time-total"),
    muteBtn: $("mute-btn"),
    volumeHighIcon: $("volume-high-icon"),
    volumeMuteIcon: $("volume-mute-icon"),
    volumeSlider: $("volume-slider"),
    speedBtn: $("speed-btn"),
    speedMenu: doc.querySelector(".speed-menu"),
    speedOptions: Array.from(doc.querySelectorAll(".speed-option")),
    pipBtn: $("pip-btn"),
    fullscreenBtn: $("fullscreen-btn"),
    fullscreenEnterIcon: $("fullscreen-enter-icon"),
    fullscreenExitIcon: $("fullscreen-exit-icon"),
    progressContainer: $("progress-container"),
    progressFill: $("progress-fill"),
    progressBuffer: $("progress-buffer"),
    progressTooltip: $("progress-tooltip"),
  };
}
