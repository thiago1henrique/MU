// Service worker mínimo para tornar o Echo instalável como PWA.
// Estratégia: network-first para navegações (sempre pega a versão mais nova
// quando há rede, cai pro cache offline) e cache-first para os ícones/manifest.
const CACHE = 'echo-shell-v1'
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa-icon.svg',
  '/pwa-192.png',
  '/pwa-512.png',
  '/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Nunca intercepta chamadas de API (Last.fm proxy etc.) — sempre rede.
  if (url.pathname.startsWith('/api/')) return

  // Navegações (HTML): network-first, cache como fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy))
          return res
        })
        .catch(() => caches.match('/').then((r) => r ?? caches.match(request))),
    )
    return
  }

  // Demais GETs: cache-first, buscando na rede quando não houver cache.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((res) => {
        // Só cacheia respostas OK do mesmo origin.
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return res
      })
    }),
  )
})
