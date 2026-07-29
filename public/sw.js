// Pulse service worker ? caches the app shell for offline/quick loads.
// Note: service workers only register on secure contexts (https or localhost).
const CACHE = "pulse-v47";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-1024.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
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
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Live data: always go to the network, fall back to any cached copy.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell: network-first so UI updates aren't stuck behind an old cache.
  // Falls back to cache when offline.
  const isShell =
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/app.js" ||
    url.pathname === "/styles.css" ||
    url.pathname === "/sw.js" ||
    url.pathname === "/manifest.webmanifest";

  if (isShell) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("/")))
    );
    return;
  }

  // Other static assets: cache-first, then network.
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
            return resp;
          })
          .catch(() => caches.match("/"))
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if (client.url && "navigate" in client) {
            try {
              client.navigate(client.url.includes("#") ? client.url : `${client.url}#portfolio`);
            } catch {}
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("/#portfolio");
    })
  );
});

