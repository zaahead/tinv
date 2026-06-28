// tinv PWA service worker — caches the app shell so the player opens offline.
// Video files are never cached (they're large and often remote); only the UI.

const CACHE = "tinv-shell-v9";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./player-core.js",
  "./tinv-format.js",
  "./compat.js",
  "./manifest.json",
  "./icon.png",
];
// Note: convert.js + the mp4-muxer are loaded lazily (only when the user
// opens Convert). Encoding itself uses the browser's native WebCodecs AV1
// encoder — no large wasm download.

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never intercept video payloads or cross-origin streams — let them go direct.
  if (url.origin !== location.origin || /\.(tinv|webm|mp4|mkv)(\?|$)/i.test(url.pathname)) {
    return;
  }

  // Network-first for the shell: always fetch fresh when online (so deploys
  // show immediately), update the cache, and fall back to cache only offline.
  // This keeps offline support without ever serving stale CSS/JS.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
  );
});
