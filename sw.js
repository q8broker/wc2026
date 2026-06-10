const CACHE_NAME = "wc2026-v13-20260610";

self.addEventListener("install", function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(["./", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png"]);
    }).catch(function() {})
  );
});

self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return key !== CACHE_NAME;
      }).map(function(key) {
        return caches.delete(key);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function(event) {
  const req = event.request;
  if (req.method !== "GET") return;

  // الصفحة الرئيسية: شبكة أولاً، ونخزن آخر نسخة ناجحة للأوفلاين
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-store" }).then(function(res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put("./", copy); }).catch(function() {});
        }
        return res;
      }).catch(function() {
        return caches.match("./").then(function(hit) {
          return hit || new Response("لا يوجد اتصال بالإنترنت", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        });
      })
    );
    return;
  }

  // بيانات Supabase والمكتبات: شبكة مباشرة بدون تخزين
  if (req.url.includes("supabase.co")) {
    event.respondWith(fetch(req));
    return;
  }

  // الباقي (مكتبات CDN، أعلام، خطوط): شبكة ثم كاش، ونخزن الناجح
  event.respondWith(
    fetch(req).then(function(res) {
      if (res && res.ok && (req.url.includes("unpkg.com") || req.url.includes("jsdelivr.net") || req.url.includes("flagcdn.com") || req.url.includes("gstatic.com") || req.url.includes("googleapis.com"))) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(req, copy); }).catch(function() {});
      }
      return res;
    }).catch(function() {
      return caches.match(req);
    })
  );
});
