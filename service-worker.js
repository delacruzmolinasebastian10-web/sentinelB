const CACHE_NAME = "sentinelb-v1";
const APP_SHELL = [
  "/",
  "/login.html",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/assets/logo.png",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];
// Instalar Service Worker
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});
// Activar nueva versión
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});
// Peticiones
self.addEventListener("fetch", event => {
  // Solo manejar peticiones GET
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Las APIs SIEMPRE deben pedir los datos al servidor.
  // No queremos datos antiguos del dashboard.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return new Response(
            JSON.stringify({
              ok: false,
              offline: true,
              error: "Sin conexión con SentinelB"
            }),
            {
              headers: {
                "Content-Type": "application/json"
              }
            }
          );
        })
    );
    return;
  }
  // Para archivos de la aplicación:
  // primero intenta obtenerlos de internet,
  // y si no hay conexión usa la versión guardada.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (
          response &&
          response.status === 200 &&
          response.type === "basic"
        ) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
