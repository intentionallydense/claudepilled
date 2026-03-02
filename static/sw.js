// No-op service worker — exists solely to satisfy PWA install criteria.
// All fetches pass through to the network; no caching.
self.addEventListener("fetch", () => {});
