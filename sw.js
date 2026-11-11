/*
 * VJH Today 3.1: the offline copy of the page's own files, so the page opens with no signal.
 * Network first: online, every file comes fresh from GitHub Pages (an update shows the next time the
 * page opens) and the copy is renewed; offline, or after six seconds with no answer, the copy is used.
 * Only this site's own files pass through here. The schedule request goes to Google directly and is
 * never seen, kept or answered by this worker; the page keeps its last schedule itself.
 */
var CACHE = 'vjh-today-3.1';
var FILES = ['./', 'app.css?v=3.1', 'app.js?v=3.1', 'img/laryngoscope.webp', 'icons/apple-touch-icon.png', 'icons/favicon-48.png',
  'fonts/atkinson-hyperlegible-next-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-next-latin-600-normal.woff2',
  'fonts/atkinson-hyperlegible-next-latin-700-normal.woff2'];
var WAIT_MS = 6000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('vjh-today-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fromNetworkOrCopy(req));
});

function copyOf(req) {
  return caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) { return hit || (req.mode === 'navigate' ? c.match('./') : undefined); });
  });
}

function fromNetworkOrCopy(req) {
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (res) { if (!settled && res) { settled = true; resolve(res); } };
    var net = fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var keep = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, keep); }).catch(function () {});
      }
      return res;
    });
    // Slow network: after WAIT_MS use the copy if there is one, and keep waiting for the network if not.
    var timer = setTimeout(function () { copyOf(req).then(finish); }, WAIT_MS);
    net.then(function (res) { clearTimeout(timer); finish(res); }, function () {
      clearTimeout(timer);
      copyOf(req).then(function (hit) { if (hit) finish(hit); else if (!settled) { settled = true; resolve(Response.error()); } });
    });
  });
}
