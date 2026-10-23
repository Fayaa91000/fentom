
/* MEG PWA preview — NEVER cache private order data, customer sessions or payment information. */
'use strict';

const OFFLINE_CACHE = 'meg-public-offline-only-v1';

const OFFLINE_URL = new URL(
  'meg-offline.html',
  self.registration.scope
).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then(cache =>
      cache.add(OFFLINE_URL)
    )
  );

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (
    request.mode !== 'navigate' ||
    request.method !== 'GET'
  ) return;

  const target = new URL(request.url);

  if (
    target.origin !== self.location.origin ||
    !target.href.startsWith(self.registration.scope)
  ) return;

  // Every real navigation is network-first
  // and never cached.
  // Only a generic public offline page is cached.
  // No sensitive customer data is stored.

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL)
    )
  );
});
