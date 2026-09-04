/**
 * Nucleus service worker — makes the installed PWA open instantly even with
 * no signal (common on a job site), while never getting in the way of real
 * data. It only ever handles the app "shell" (the page itself, the manifest,
 * the icons) — it never touches /api/*, /data/*, or /auth/* requests, which
 * always go straight to the network untouched. That split matters: caching
 * an API response here could quietly serve someone a stale, wrong version of
 * job data, or interfere with the login flow. The app's own code already
 * handles being offline for real data (queues edits in sessionStorage and
 * retries — see index.html's PERSISTENCE section); this worker's only job is
 * making the app itself load when the network can't be reached at all.
 *
 * Bump CACHE_VERSION whenever this file OR the shell files it lists change,
 * so returning devices pick up the update instead of running a stale shell
 * forever.
 *
 * Also handles push notifications (see 'push'/'notificationclick' below) —
 * a real phone/tablet alert for a cost impact or request assigned to you,
 * even with Nucleus closed. That's a separate job from the shell-caching
 * above and doesn't touch it: registering for push (index.html's
 * togglePushSubscription) reuses this same service worker rather than a
 * second one, since a page can only ever have one active at a time.
 */
const CACHE_VERSION = 'nucleus-shell-v2';
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  // Only ever the app shell itself — never API/data/auth calls, and never a
  // cross-origin request (Google Fonts, etc. — let the browser's normal HTTP
  // cache handle those; this worker doesn't need to).
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/') || url.pathname.startsWith('/auth/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs (saves, logins)
  const url = new URL(req.url);
  if (!isShellRequest(url)) return; // let it pass straight through, untouched

  // Network-first: whenever there's a connection, always fetch the latest
  // shell (so app updates show up normally) and refresh the cache copy.
  // Only fall back to the cached copy when the network truly fails, which is
  // exactly the offline/no-signal case this exists for.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        // Nothing cached for this exact request (e.g. first-ever visit with
        // no connection) — for a navigation, fall back to the cached shell
        // page itself so the app still opens rather than showing a browser
        // error screen.
        if (req.mode === 'navigate') return caches.match('/');
        return Response.error();
      }))
  );
});

// ---- Push notifications: the server (see server/webpush.js or
// lib/webpush.js) sends one of these for every new Nucleus notification a
// subscribed device's team member receives — a cost impact, a request
// assigned to them. The payload is plain JSON (see notifyNewPushNotifications
// server-side): {title, body, jobId, refId, notifType}. ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'Nucleus';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.refId || undefined, // a second push for the same item replaces the first instead of stacking
    data: { jobId: data.jobId || null, refId: data.refId || null, notifType: data.notifType || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification: focus an already-open Nucleus tab and tell it
// where to navigate (via postMessage — see index.html's
// 'nucleus-notification-click' listener, the same navigation
// openNotification() already does for the in-app bell), or open a new tab
// straight to that job if none is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { jobId, refId, notifType } = event.notification.data || {};
  const targetUrl = jobId ? '/?openJob=' + encodeURIComponent(jobId) + (notifType ? '&openJobType=' + encodeURIComponent(notifType) : '') : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'nucleus-notification-click', jobId, refId, notifType });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
