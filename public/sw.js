/*
 * Service worker (point 62).
 *
 * THE RULE THAT SHAPES THIS FILE: no financial figure is ever served from a
 * cache. A balance that is thirty seconds old is not "slightly stale", it is
 * wrong, and an operator who takes a payment against it corrupts the ledger.
 *
 * So the cache holds exactly two things:
 *
 *   1. Build assets under /_next/static — content-hashed, so a cached copy is
 *      byte-identical to the network copy by construction.
 *   2. One offline page, which states plainly that there is no connection and
 *      shows NO numbers at all.
 *
 * Every page request goes to the network first and falls back to that offline
 * page. Nothing else is intercepted: API routes, server actions and every POST
 * pass straight through, so a failed write fails loudly instead of appearing
 * to succeed.
 */

const VERSION = "capital-control-v1";
const ASSETS = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== ASSETS && key !== SHELL)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isImmutableAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Anything that changes state is none of this worker's business.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache data. A report or an export must reach the server or fail.
  if (url.pathname.startsWith("/api/")) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSETS).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(OFFLINE_URL)
          .then(
            (hit) =>
              hit ??
              new Response("Sin conexión.", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              }),
          ),
      ),
    );
  }
});
