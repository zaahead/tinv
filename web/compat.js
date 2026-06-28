// Browser capability check for the tinv PWA.
//
// A .tinv decodes to AV1/Opus WebM, so the real requirement is AV1 video
// decode — not "Chromium" per se (recent Firefox/Safari can play AV1 too).
// We feature-detect AV1 and the crypto needed to de-obfuscate the container,
// and only warn when something is actually missing.

/** Can this browser decode AV1 video? */
export function canPlayAv1() {
  try {
    const v = document.createElement("video");
    // AV1 in WebM and in MP4 — either counts.
    const webm = v.canPlayType('video/webm; codecs="av01.0.05M.08"');
    const mp4 = v.canPlayType('video/mp4; codecs="av01.0.05M.08"');
    if (webm === "probably" || webm === "maybe" || mp4 === "probably" || mp4 === "maybe") {
      return true;
    }
    // Fallback: MediaSource type support (stricter, returns boolean).
    if (window.MediaSource && MediaSource.isTypeSupported) {
      return MediaSource.isTypeSupported('video/webm; codecs="av01.0.05M.08"');
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** Crypto needed to decode the .tinv container. */
export function hasCrypto() {
  return !!(window.crypto && crypto.subtle && crypto.getRandomValues);
}

/** Rough "is this a Chromium browser?" — only used to tailor the message. */
export function isChromium() {
  const ua = navigator.userAgent;
  // Exclude Firefox/Safari; include Chrome/Edge/Brave/Opera/Arc/etc.
  return /Chrome|Chromium|Edg|OPR/.test(ua) && !/Firefox/.test(ua);
}

/**
 * Returns null if everything works, or a { title, detail } describing the
 * problem so the UI can show a banner.
 */
export function checkSupport() {
  if (!hasCrypto()) {
    return {
      title: "This browser is missing required features.",
      detail: "tinv needs the Web Crypto API. Try an up-to-date Chrome or Edge.",
    };
  }
  if (!canPlayAv1()) {
    return {
      title: "This browser can't play .tinv videos.",
      detail: isChromium()
        ? "Your browser doesn't support AV1 video. Update it, or use the latest Chrome or Edge."
        : "tinv videos use AV1. For the best experience use a Chromium browser — Chrome, Edge, Brave, or Arc.",
    };
  }
  return null;
}
