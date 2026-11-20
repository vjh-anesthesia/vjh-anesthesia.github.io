/*
 * VJH Today 3.2: the offline copy of the page's own files.
 * The phone's copy first (3.2): every file the page needs is answered at once from the copy, so the page
 * opens without waiting on the hospital's network; until 3.1 each file waited up to six seconds for the
 * network before the copy was used. The page itself (index.html) is also fetched in the background and
 * the copy renewed, and the browser checks this file for a newer version each time the page opens.
 * An update therefore shows on the second opening after it is published: the first opening finds and
 * installs it, the next one shows it. Files with ?v= in their address never change under that address,
 * so they are not fetched again; a new version has a new address, listed in FILES below.
 * Only this site's own files pass through here. The schedule request goes to Google directly and is
 * never seen, kept or answered by this worker; the page keeps its last schedule itself.
 */
var CACHE = 'vjh-today-3.2';
var FILES = ['./', 'app.css?v=3.2', 'app.js?v=3.2', 'img/laryngoscope.webp', 'icons/apple-touch-icon.png', 'icons/favicon-48.png',
  'fonts/atkinson-hyperlegible-next-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-next-latin-600-normal.woff2',
  'fonts/atkinson-hyperlegible-next-latin-700-normal.woff2'];

self.addEventListener('install', function (e) {
  // cache: 'reload' skips the browser's own short-lived cache, so a new version installs the new files.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
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
  e.respondWith(copyOrNetwork(e, req));
});

function keep(c, req, res) {
  if (res && res.ok && res.type === 'basic') c.put(req.mode === 'navigate' ? './' : req, res.clone()).catch(function () {});
  return res;
}

function copyOrNetwork(e, req) {
  var nav = req.mode === 'navigate';
  return caches.open(CACHE).then(function (c) {
    // A page opened with old link options (?k=...) is still the same page.
    return (nav ? c.match('./') : c.match(req)).then(function (hit) {
      if (hit) {
        // The page itself is renewed in the background; it is used from the next opening.
        // no-cache asks GitHub whether the page changed (a small reply when it has not) instead of trusting a stored copy.
        if (nav) e.waitUntil(fetch('./', { cache: 'no-cache' }).then(function (res) { return keep(c, req, res); }).catch(function () {}));
        return hit;
      }
      return fetch(req).then(function (res) { return keep(c, req, res); });
    });
  });
}
