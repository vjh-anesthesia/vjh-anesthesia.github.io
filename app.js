/*
 * VJH Anesthesia: Today. Version 3.1, 11 November 2026 (the GitHub Pages edition, with the calendar).
 * Requires the calendar service (VJH_Calendar.gs) version 3.0 or later; 3.4 issues links to this page.
 *
 * WHAT IT IS
 * A static page: GitHub Pages serves these files and nothing else. The schedule comes straight from
 * the calendar service (the schedule Sheet's Apps Script web app), which answers a member's key with
 * every member's assignment for each day, as JSON. Each member opens the page with their own link,
 *   https://<this site>/#k=<their calendar key>
 * The key sits after the #, so the browser never sends it to GitHub: only the calendar service sees it,
 * exactly as it sees it for the calendar feed. The page marks the key's owner as "you".
 *
 * WHAT IT KEEPS ON THE PHONE (localStorage, this site only)
 * - The key, so that a home screen app opened without the link (Android installs open the bare address)
 *   still knows whose page it is. Without a key, the page asks for the link to be pasted once.
 * - The last schedule it read, so the page opens at once and still works with no signal. It always
 *   says when what it shows was read. A refusal (link retired, member no longer on the schedule, link not
 *   valid) erases both. A temporary failure (no connection, the service unable to read the Sheet just
 *   now, a reply that is not usable data) keeps the schedule on screen and says it could not refresh.
 * - Which calendar layout (Days, Week or Month) was used last, so the calendar opens in it again.
 * The service worker (sw.js) keeps a copy of the page's own files for opening offline; it never sees
 * the schedule request.
 *
 * THE CALENDAR (3.1)
 * A second view, reached from Calendar in the day view's top bar: the same reading of the schedule over
 * many days, as a scrolling list of days, a week grid of every member, or a month of the reader's own
 * assignments. It asks nothing more of the calendar service and works offline like the day view.
 *
 * LINK OPTIONS (after the key, joined with &)
 *   date=2026-12-24   open on that date instead of today (a real calendar date; anything else is ignored)
 *
 * THE DATA (VJH_Calendar.gs, vjhCal_buildPageData_ and doGet with view=data)
 * on failure  { "error": "<one sentence for the reader>" }
 * on success  { version, readAt (ms), today, offsetMin (BC offset from UTC, -420), members [names],
 *               days [ascending yyyy-mm-dd], holidays [dates], lateStart [dates], services [names],
 *               info [null, [kind, text, start hhmm, end hhmm, note], ...],
 *               cells [one row per day: an index into info per member, 0 = empty], me, self }
 * kind is daycall, nightcall, or, pac2 (timed: start and end as hhmm) or post, vacation, dayoff,
 * closure, flagged (untimed: '' for both). A timed entry ends on the following day exactly when
 * end <= start, so a shift lasts at most 24 hours; who is on call now is decided from those instants.
 * Every part of the data is checked (shapeProblem) before anything is drawn.
 */
(function () {
  'use strict';

  var VERSION = '3.1';
  // The calendar web app (the schedule Sheet's project). Not a secret: it returns nothing without a member key.
  var SERVICE = 'https://script.google.com/macros/s/AKfycbxPz7RiFA6CFB77qRqqQZ8wz23HNM-VpWC5mWmKYeMgYPUCdLexJPlspH4MzyK82UzBrQ/exec';
  var STORE_KEY = 'vjhToday.key', STORE_DATA = 'vjhToday.schedule';
  var FETCH_TIMEOUT_MS = 30000, SLOW_MS = 12000;
  var STALE_MS = 15 * 60000;          // refresh by itself, while showing, once the reading is this old
  var RESUME_MS = 5 * 60000;          // and on coming back to the page, once the last try is this old
  var AGENDA_DAYS = 28;

  var DOWN = 'The schedule could not be read just now. Please check your connection and try again.';
  var OLD = 'The Today page needs the calendar service updated to version 3.0 or later. Please let the scheduler know.';
  var INVALID = 'This is not a valid VJH link. Please use the link the scheduler sent you.';
  // The calendar service's own sentence when it cannot read its keys or the Sheet (VJH_Calendar.gs,
  // doGet, M.down for view=data). Matched exactly: if that wording ever changes, the error is treated
  // as a refusal and the page clears, which is the safe direction.
  var SERVICE_DOWN = 'The schedule could not be read just now. Please try again in a minute.';

  var app = document.getElementById('app');
  var LOADING_HTML = app.innerHTML;     // the spinner, as served
  var PREVIEW = window.VJH_PREVIEW || null;   // a local preview with the schedule built in; never set on the live site
  var K = '', START_DATE = '', LINK_DATE = '';   // LINK_DATE: the date= of the link as given, valid or not
  var D = null, idx = {}, HOL = {}, LATE = {}, FIRST = '', LAST = '';
  var loading = false, refreshing = false, slowTimer = null, refreshFailed = false, lastTry = 0, lampLit = false;
  var seq = 0;                        // each request's number: an answer is used only if no later request or link replaced it

  var WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var WDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LABEL = { daycall: 'Day call', nightcall: 'Night call', pac2: 'PAC2 clinic', post: 'Post call',
                vacation: 'Vacation', dayoff: 'Day off', closure: 'OR closure' };

  // ---- the phone's own storage: best effort only (private browsing can refuse it)
  function store(name, value) {
    try { if (value == null) localStorage.removeItem(name); else localStorage.setItem(name, value); } catch (err) { /* kept in memory only */ }
  }
  function recall(name) { try { return localStorage.getItem(name); } catch (err) { return null; } }
  function validKey(k) { return typeof k === 'string' && /^[0-9a-f]{32}$/.test(k); }
  function savedSchedule(k) {
    var s = null;
    try { s = JSON.parse(recall(STORE_DATA) || 'null'); } catch (err) { s = null; }
    if (!s || s.k !== k || !s.data) return null;
    var problem = shapeProblem(s.data);
    if (problem) { store(STORE_DATA, null); return null; }
    return s.data;
  }
  function forget(k) {
    if (recall(STORE_KEY) === k) store(STORE_KEY, null);
    var s = null;
    try { s = JSON.parse(recall(STORE_DATA) || 'null'); } catch (err) { s = null; }
    if (!s || s.k === k) store(STORE_DATA, null);
  }

  // ---- checking the data: nothing that fails here is ever drawn
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function shapeProblem(d) {
    var TIMED = { daycall: true, nightcall: true, or: true, pac2: true };
    var UNTIMED = { post: true, vacation: true, dayoff: true, closure: true, flagged: true };
    var isHHMM = function (s) { return typeof s === 'string' && /^([01]\d|2[0-3])[0-5]\d$/.test(s); };
    var isInt = function (n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; };
    var i, j;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'not an object';
    var arrays = ['members', 'days', 'info', 'cells'];
    for (i = 0; i < arrays.length; i++) if (!Array.isArray(d[arrays[i]])) return arrays[i] + ' is not a list';
    if (!d.days.length || !d.members.length) return 'no days or no members';
    for (i = 0; i < d.members.length; i++) {
      if (typeof d.members[i] !== 'string' || !d.members[i].trim()) return 'member ' + i + ' has no name';
    }
    var optional = { holidays: 'date', lateStart: 'date', services: 'text' };
    var names = Object.keys(optional);
    for (i = 0; i < names.length; i++) {
      var v = d[names[i]];
      if (v === undefined) continue;
      if (!Array.isArray(v)) return names[i] + ' is not a list';
      for (j = 0; j < v.length; j++) {
        var ok = optional[names[i]] === 'date' ? isDate(v[j]) : (typeof v[j] === 'string' && v[j].trim() !== '');
        if (!ok) return names[i] + ' entry ' + j + ' is not a ' + (optional[names[i]] === 'date' ? 'date' : 'name');
      }
    }
    if (!d.info.length || d.info[0] !== null) return 'info does not begin with the empty-cell marker';
    for (i = 1; i < d.info.length; i++) {
      var x = d.info[i];
      if (!Array.isArray(x) || x.length < 4) return 'info entry ' + i + ' is not an assignment record';
      if (!TIMED[x[0]] && !UNTIMED[x[0]]) return 'info entry ' + i + ' has an unknown kind';
      if (typeof x[1] !== 'string') return 'info entry ' + i + ' has no text';
      if (TIMED[x[0]] ? !(isHHMM(x[2]) && isHHMM(x[3])) : (x[2] !== '' || x[3] !== '')) {
        return 'info entry ' + i + ' (' + x[0] + ') has ' + (TIMED[x[0]] ? 'invalid hours' : 'hours it should not have');
      }
      if (x.length > 4 && typeof x[4] !== 'string') return 'info entry ' + i + ' has a note that is not text';
    }
    if (d.cells.length !== d.days.length) return d.cells.length + ' rows of cells for ' + d.days.length + ' days';
    for (i = 0; i < d.days.length; i++) {
      if (!isDate(d.days[i]) || (i && d.days[i] <= d.days[i - 1])) return 'day ' + i + ' is not an ascending date';
      var row = d.cells[i];
      if (!Array.isArray(row) || row.length !== d.members.length) return 'day ' + d.days[i] + ' does not have one cell per member';
      for (j = 0; j < row.length; j++) {
        if (!(isInt(row[j]) && row[j] >= 0 && row[j] < d.info.length)) return 'day ' + d.days[i] + ' points outside the info table';
      }
    }
    if (!isInt(d.offsetMin) || Math.abs(d.offsetMin) > 14 * 60) return 'the UTC offset is missing or impossible';
    if (typeof d.readAt !== 'number' || !isFinite(d.readAt)) return 'the reading time is missing';
    if (d.me !== undefined && !(isInt(d.me) && d.me >= -1 && d.me < d.members.length)) return 'me is not a member position';
    return null;
  }

  // ---- asking the calendar service. Resolves to { data } or { error, temporary? }; never rejects.
  function interpret(text) {
    if (/^\s*BEGIN:VCALENDAR/.test(text)) {
      console.error('VJH Today: the calendar service answered view=data with calendar text, so it is older than 3.0.');
      return { error: OLD };
    }
    var data;
    try { data = JSON.parse(text); } catch (err) {
      console.error('VJH Today: the calendar service did not answer JSON: ' + String(text).slice(0, 120));
      return { error: DOWN, temporary: true };
    }
    if (data && data.error) {
      return String(data.error) === SERVICE_DOWN ? { error: String(data.error), temporary: true } : { error: String(data.error) };
    }
    if (!(parseFloat(data && data.version) >= 3)) {
      console.error('VJH Today: the calendar service reports version ' + (data && data.version) + '; 3.0 or later is needed.');
      return { error: OLD };
    }
    delete data.preview; delete data.previewDelay; delete data.self;   // not used here
    var problem = shapeProblem(data);
    if (problem) {
      console.error('VJH Today: unexpected data from the calendar service: ' + problem);
      return { error: DOWN, temporary: true };
    }
    return { data: data };
  }
  function ask(k) {
    if (!validKey(k)) return Promise.resolve({ error: INVALID });
    if (!window.fetch) return Promise.resolve({ error: 'This browser is too old for the Today page. Please update it.' });
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FETCH_TIMEOUT_MS);
    // A simple GET with no credentials: Google answers it with a redirect to its content server, which allows any site to read the reply.
    return fetch(SERVICE + '?view=data&k=' + k, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('the calendar service answered HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) { clearTimeout(timer); return interpret(text); },
            function (err) { clearTimeout(timer); console.error('VJH Today: ' + (err && err.message || err)); return { error: DOWN, temporary: true }; });
  }

  function list(x) { return Array.isArray(x) ? x : []; }
  function setData(d) {
    D = d; idx = {}; HOL = {}; LATE = {};
    D.days.forEach(function (x, i) { idx[x] = i; });
    list(D.holidays).forEach(function (x) { HOL[x] = true; });
    list(D.lateStart).forEach(function (x) { LATE[x] = true; });
    FIRST = D.days[0]; LAST = D.days[D.days.length - 1];
  }

  // ---- dates and time (BC local time from the offset the service sends, not the phone's zone database)
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function utc(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  function isoOf(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function add(iso, n) { return isoOf(utc(iso) + n * 86400000); }
  function dow(iso) { return new Date(utc(iso)).getUTCDay(); }
  function localMs() { return Date.now() + D.offsetMin * 60000; }
  function todayIso() { return isoOf(localMs()); }
  function clock(ms) { var l = new Date(ms + D.offsetMin * 60000); return pad(l.getUTCHours()) + ':' + pad(l.getUTCMinutes()); }
  function span(s, e) { return s + '–' + e; }
  function dayMonth(iso) { return (+iso.slice(8, 10)) + ' ' + MONS[+iso.slice(5, 7) - 1]; }
  function shortDate(iso) { return WDS[dow(iso)] + ' ' + dayMonth(iso); }
  function longDate(iso) { return (+iso.slice(8, 10)) + ' ' + MON[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); }
  function validIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(utc(s)) === s; }
  function inRange(iso) { return validIso(iso) && iso >= FIRST && iso <= LAST; }
  // Whether the Sheet has a column for the date. A date can be in range and still absent.
  function has(iso) { return idx[iso] != null; }
  function clamp(iso) { return iso < FIRST ? FIRST : iso > LAST ? LAST : iso; }

  // A cell: undefined outside the schedule, null when empty, else [kind, text, start, end, note].
  function cell(iso, m) { var i = idx[iso]; if (i == null) return undefined; return D.info[D.cells[i][m]] || null; }
  function kindOf(x) { return x === undefined ? 'gap' : x ? x[0] : 'none'; }
  function runEnd(iso, m, kind) {
    var d = iso;
    for (;;) { var n = add(d, 1), x = cell(n, m); if (x === undefined || kindOf(x) !== kind) return d; d = n; }
  }
  function splitRoom(text) {
    var up = String(text).toUpperCase(), s = list(D.services);
    for (var i = 0; i < s.length; i++) {
      if (up === s[i]) return [text, ''];
      if (up.indexOf(s[i] + ' ') === 0) return [text.slice(0, s[i].length), text.slice(s[i].length + 1)];
    }
    return ['', text];
  }

  // ---- DOM helpers
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function kids(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function button(cls, text, attr) { var b = el('button', cls, text); b.type = 'button'; if (attr) b.setAttribute(attr, '1'); return b; }
  function who(m) {
    var b = el('button', 'who', D.members[m]);
    b.type = 'button';
    b.setAttribute('data-m', m);
    b.setAttribute('aria-label', D.members[m] + ', see the next four weeks');
    if (m === D.me) b.appendChild(el('span', 'you', ' (you)'));
    return b;
  }
  function roomNode(text) {
    var w = el('span', 'what');
    if (!text) { w.textContent = 'Room not yet named'; w.className += ' svc'; return w; }
    var p = splitRoom(text);
    if (p[0]) w.appendChild(el('span', 'svc', p[0] + (p[1] ? ' ' : '')));
    if (p[1]) w.appendChild(document.createTextNode(p[1]));
    return w;
  }

  // ---- state
  // cal: null in the day view, else the calendar layout showing; calDate: its chosen date (in Days, the first day listed);
  // calTop: in Days, the day at the top of the screen; calEnd: in Days, the first day not yet listed.
  var state = { date: null, person: null, personName: null, from: null, weeks: 1, dayScroll: 0, notice: null, cal: null, calDate: null, calTop: null, calEnd: null };
  // Opened without date=, the page follows today across midnight; opened on a named date, it stays there.
  var followToday = true, lastToday = null, started = false;
  var nowBox = null, staleBox = null;

  function go(iso, dir) {
    if (!inRange(iso)) return;   // inRange also rejects anything that is not a real date
    followToday = iso === todayIso();
    state.date = iso;
    render(dir);
  }

  // ---- the day view
  function header(iso) {
    var top = el('header');
    var bar = el('div', 'bar');
    bar.appendChild(el('span', 'brand', 'VJH Anesthesia'));
    var t = todayIso();
    if (iso !== t && inRange(t)) { var tb = button('link', 'Today'); tb.setAttribute('data-go', t); bar.appendChild(tb); }
    bar.appendChild(button('link', 'Calendar', 'data-cal-open'));
    if (D.me >= 0) { var mb = button('link', 'My schedule'); mb.setAttribute('data-m', D.me); bar.appendChild(mb); }
    top.appendChild(bar);

    var pick = el('label', 'pick');
    var h = el('h1');
    h.appendChild(el('span', 'wd', WD[dow(iso)]));
    var dt = el('span', 'dt', longDate(iso));
    if (iso === t) { dt.textContent = ''; dt.appendChild(el('b', '', 'Today')); dt.appendChild(document.createTextNode(', ' + longDate(iso))); }
    h.appendChild(dt);
    var inp = el('input');
    inp.type = 'date'; inp.min = FIRST; inp.max = LAST; inp.value = iso;
    inp.setAttribute('aria-label', 'Choose a date');
    inp.addEventListener('change', function () { if (inp.value) go(clamp(inp.value), inp.value > iso ? 'l' : 'r'); });
    inp.addEventListener('click', function () { try { if (inp.showPicker) inp.showPicker(); } catch (err) { /* the native tap still opens it */ } });
    kids(pick, inp, h);
    top.appendChild(pick);

    var wk = el('nav', 'week');
    wk.setAttribute('aria-label', 'Week');
    var prev = button('step', '‹'); prev.setAttribute('data-go', add(iso, -1)); prev.setAttribute('aria-label', 'Previous day');
    prev.disabled = iso <= FIRST;
    wk.appendChild(prev);
    var mon = add(iso, -((dow(iso) + 6) % 7));
    for (var i = 0; i < 7; i++) {
      var d = add(mon, i);
      var gap = inRange(d) && !has(d);
      var b = button('day' + (d === iso ? ' sel' : '') + (d === t ? ' today' : '') + (HOL[d] ? ' hol' : '') + (gap ? ' gap' : ''));
      b.setAttribute('data-go', d);
      b.setAttribute('aria-label', WD[dow(d)] + ' ' + longDate(d) + (HOL[d] ? ', statutory holiday' : '') + (gap ? ', schedule unavailable' : ''));
      if (d === iso) b.setAttribute('aria-current', 'date');
      b.disabled = !inRange(d);
      kids(b, el('span', 'l', 'MTWTFSS'.charAt(i)), el('span', 'n', String(+d.slice(8, 10))));
      wk.appendChild(b);
    }
    var next = button('step', '›'); next.setAttribute('data-go', add(iso, 1)); next.setAttribute('aria-label', 'Next day');
    next.disabled = iso >= LAST;
    wk.appendChild(next);
    top.appendChild(wk);
    return top;
  }

  // Who is on call at this moment, decided from each shift's actual start and end, never from its
  // name: Shift Times may set any hours. A timed entry ends on the following day exactly when its end
  // is not after its start, the calendar service's own rule (vjhCal_shift_), so a shift lasts at most
  // 24 hours and only yesterday's and today's entries can cover the present moment.
  function at(iso, hhmm) { return utc(iso) + (+hhmm.slice(0, 2)) * 3600000 + (+hhmm.slice(2)) * 60000; }
  function onCallNow() {
    var t = todayIso(), now = localMs(), out = [];
    [add(t, -1), t].forEach(function (d) {
      if (!has(d)) return;
      D.members.forEach(function (_, m) {
        var x = cell(d, m);
        if (!x || (x[0] !== 'daycall' && x[0] !== 'nightcall')) return;
        var s = at(d, x[2]), e = at(x[3] <= x[2] ? add(d, 1) : d, x[3]);
        if (s <= now && now < e) out.push({ m: m, role: LABEL[x[0]], end: x[3], endMs: e });
      });
    });
    out.sort(function (a, b) { return a.endMs - b.endMs; });
    return out;
  }
  function left(endMs) {
    var min = Math.max(0, Math.ceil((endMs - localMs()) / 60000)), h = Math.floor(min / 60), mm = min % 60;
    return (h ? h + ' h ' : '') + mm + ' min left';
  }
  // Which of the two days the band depends on are missing from the Sheet, in words, or '' if neither.
  function missingForNow() {
    var t = todayIso(), noY = !has(add(t, -1)), noT = !has(t);
    if (noY && noT) return 'neither yesterday nor today is in the Sheet';
    if (noY) return 'yesterday is not in the Sheet, so an overnight shift that began then is unknown';
    if (noT) return 'today is not in the Sheet';
    return '';
  }
  // The band stands beside a laryngoscope drawn as a street light: its bulb lights whoever is on call.
  function nowBand() {
    var post = el('section', 'lamppost');
    post.setAttribute('aria-label', 'On call now');
    var img = el('img', 'lamp');
    img.src = 'img/laryngoscope.webp'; img.alt = ''; img.width = 85; img.height = 148; img.decoding = 'async';
    img.setAttribute('aria-hidden', 'true');
    post.appendChild(img);
    var glow = el('span', 'glow'); glow.setAttribute('aria-hidden', 'true');
    post.appendChild(glow);
    var box = el('div', 'now');
    box.setAttribute('aria-live', 'polite');
    var beam = el('span', 'beam'); beam.setAttribute('aria-hidden', 'true');
    box.appendChild(beam);
    box.appendChild(el('p', 'h', 'On call now, ' + clock(Date.now())));
    var calls = onCallNow(), gap = missingForNow();
    if (!calls.length) {
      box.appendChild(el('p', 'none', gap ? 'On-call coverage cannot be shown: ' + gap + '.' : 'No one is listed on call right now.'));
    } else {
      // The light comes on once, the first time the band is drawn lit; later redraws keep it steady.
      post.className += ' lit' + (lampLit ? '' : ' first');
      lampLit = true;
      calls.forEach(function (c) {
        var r = el('div', 'r');
        kids(r, who(c.m), el('span', 'until', 'until ' + c.end), el('span', 'role', c.role), el('span', 'left', left(c.endMs)));
        box.appendChild(r);
      });
      if (gap) box.appendChild(el('p', 'gapnote', 'This may be incomplete: ' + gap + '.'));
    }
    post.appendChild(box);
    return post;
  }

  function group(cls, title, extra) {
    var s = el('section', 'grp ' + cls), h = el('h2');
    h.appendChild(el('span', '', title));
    if (extra) h.appendChild(el('span', 'x', extra));
    s.appendChild(h);
    var ul = el('ul');
    s.appendChild(ul);
    return { node: s, list: ul };
  }

  function dayBody(iso) {
    var frag = document.createDocumentFragment();
    if (!inRange(iso)) {
      frag.appendChild(el('p', 'empty', 'This day is outside the schedule, which runs from ' + shortDate(FIRST) + ' ' + FIRST.slice(0, 4) +
        ' to ' + shortDate(LAST) + ' ' + LAST.slice(0, 4) + '.'));
      return frag;
    }
    if (!has(iso)) {
      frag.appendChild(el('p', 'empty', 'Schedule unavailable for this date: the Sheet has no column for it.'));
      return frag;
    }
    var by = { daycall: [], nightcall: [], or: [], pac2: [], post: [], vacation: [], dayoff: [], closure: [], flagged: [], none: [] };
    D.members.forEach(function (_, m) { var x = cell(iso, m); (by[kindOf(x)] || by.flagged).push({ m: m, x: x }); });

    var notes = el('div', 'notes');
    if (HOL[iso]) notes.appendChild(el('p', 'hol', 'Statutory holiday.'));
    if (LATE[iso]) notes.appendChild(el('p', '', 'Late-start Thursday: operating rooms open at 0830.'));
    if (notes.childNodes.length) frag.appendChild(notes);

    var listed = D.members.length - by.none.length;
    if (!listed) { frag.appendChild(el('p', 'empty', 'Nothing is listed in the Sheet for this day.')); }

    var calls = by.daycall.concat(by.nightcall);
    if (calls.length) {
      var g = group('call', 'On call');
      calls.forEach(function (c) {
        g.list.appendChild(kids(el('li', 'timed'), el('span', 't', span(c.x[2], c.x[3])), who(c.m), el('span', 'what', LABEL[c.x[0]])));
      });
      frag.appendChild(g.node);
    }
    if (by.or.length) {
      by.or.sort(function (a, b) { return a.x[1] < b.x[1] ? -1 : a.x[1] > b.x[1] ? 1 : a.m - b.m; });
      var hours = {};
      by.or.forEach(function (c) { hours[span(c.x[2], c.x[3])] = true; });
      var one = Object.keys(hours).length === 1 ? Object.keys(hours)[0] : '';
      var go2 = group('or', 'Operating rooms', one);
      by.or.forEach(function (c) {
        go2.list.appendChild(kids(el('li', 'room'), who(c.m), roomNode(c.x[1]), one ? null : el('span', 't', span(c.x[2], c.x[3]))));
      });
      frag.appendChild(go2.node);
    }
    if (by.pac2.length) {
      var gp = group('pac2', 'PAC2 clinic');
      by.pac2.forEach(function (c) { gp.list.appendChild(kids(el('li', 'timed'), el('span', 't', span(c.x[2], c.x[3])), who(c.m), null)); });
      frag.appendChild(gp.node);
    }
    if (by.post.length) {
      var gq = group('post', 'Post call'), li = el('li', 'names');
      by.post.forEach(function (c) { li.appendChild(who(c.m)); });
      gq.list.appendChild(li);
      frag.appendChild(gq.node);
    }
    var away = by.vacation.concat(by.dayoff, by.closure);
    if (away.length) {
      var ga = group('away', 'Away');
      away.forEach(function (c) {
        var k = c.x[0], end = k === 'closure' ? iso : runEnd(iso, c.m, k);
        var what = LABEL[k] + (end > iso ? ' to ' + shortDate(end) : '');
        ga.list.appendChild(kids(el('li', 'room'), who(c.m), el('span', 'what', what)));
      });
      frag.appendChild(ga.node);
    }
    if (by.flagged.length) {
      var gf = group('flag', 'Check the Sheet');
      by.flagged.forEach(function (c) {
        var txt = c.x ? '“' + c.x[1] + '” is not a recognised entry' + (c.x[4] ? ' (' + c.x[4] + '?)' : '') : 'Unrecognised entry';
        gf.list.appendChild(kids(el('li', 'room'), who(c.m), el('span', 'what', txt)));
      });
      frag.appendChild(gf.node);
    }
    if (by.none.length && listed) {
      var gn = group('none', 'Nothing listed'), ln = el('li', 'names');
      by.none.forEach(function (c) { ln.appendChild(who(c.m)); });
      gn.list.appendChild(ln);
      frag.appendChild(gn.node);
    }
    return frag;
  }

  function footer(hint) {
    var f = el('footer', 'foot');
    f.appendChild(el('p', '', 'Read from the schedule Sheet at ' + readWhen() +
      '. Your calendar link uses the same reading. For a change made today, the Sheet is the record.'));
    f.appendChild(el('p', '', hint || 'Tap a name for that person’s next four weeks. Swipe, or use the arrows, to change day.'));
    var rb = button('link', refreshing ? 'Refreshing…' : 'Refresh from the Sheet', 'data-refresh');
    rb.disabled = refreshing;
    f.appendChild(kids(el('p'), rb));
    f.appendChild(el('p', '', 'VJH Today ' + VERSION + '.'));
    return f;
  }

  // When the schedule on screen was read, with the day too once it is not today's reading.
  function readWhen() {
    var day = isoOf(D.readAt + D.offsetMin * 60000);
    return clock(D.readAt) + (day !== todayIso() ? ' on ' + shortDate(day) : '');
  }
  // While a refresh runs over an old reading, say so; after a failed refresh the schedule on screen is
  // kept, and says so until a refresh succeeds; otherwise, once the reading is old, offer a refresh.
  function staleNotice() {
    if (D.preview && !refreshFailed) return null;
    var old = Date.now() - D.readAt >= STALE_MS;
    if (refreshing) {
      if (!old && !refreshFailed) return null;
      var w = el('p', 'stale busy', 'Showing the schedule as read at ' + readWhen() + '. Checking for changes…');
      w.setAttribute('role', 'status');
      return w;
    }
    if (!refreshFailed && !old) return null;
    var a = button('stale' + (refreshFailed ? ' failed' : ''), null, 'data-refresh');
    a.appendChild(document.createTextNode(refreshFailed
      ? 'Could not refresh just now. Showing the schedule as read at ' + readWhen() + '. '
      : 'This page was read from the Sheet at ' + readWhen() + '. '));
    a.appendChild(el('b', '', refreshFailed ? 'Try again' : 'Refresh for any later changes'));
    return a;
  }

  // ---- the person view
  function agendaText(x) {
    var k = kindOf(x);
    if (k === 'gap') return { k: k, label: 'Schedule unavailable' };
    if (k === 'none') return { k: k, label: 'Nothing listed' };
    if (k === 'or') return { k: k, room: x[1], time: span(x[2], x[3]) };
    if (k === 'flagged') return { k: k, label: 'Check the Sheet: “' + x[1] + '”' };
    return { k: k, label: LABEL[k] || x[1], time: x[2] ? span(x[2], x[3]) : '' };
  }
  function personView() {
    var m = state.person, frag = document.createDocumentFragment();
    var back = button('back', state.cal ? '‹ Back to the calendar' : '‹ Back to ' + shortDate(state.date), 'data-back');
    frag.appendChild(kids(el('div', 'bar'), back));
    var wrap = el('div', 'person');
    wrap.appendChild(el('h1', '', D.members[m]));
    var from = state.from, to = add(from, AGENDA_DAYS * state.weeks - 1);
    if (to > LAST) to = LAST;
    wrap.appendChild(el('p', 'sub', (m === D.me ? 'Your schedule' : 'Schedule') + ' from ' + shortDate(from) + ' to ' + shortDate(to) + '.'));
    var ol = el('ol', 'agenda');
    var d = from;
    while (d <= to) {
      var x = cell(d, m), a = agendaText(x), end = d;
      if (a.k === 'gap' || a.k === 'none' || a.k === 'vacation' || a.k === 'dayoff' || a.k === 'closure') {
        while (add(end, 1) <= to && kindOf(cell(add(end, 1), m)) === a.k && !HOL[add(end, 1)]) end = add(end, 1);
      }
      var li = el('li', 'k-' + a.k);
      var dd = el('span', 'd', shortDate(d));
      if (end !== d) { dd.appendChild(document.createElement('br')); dd.appendChild(document.createTextNode('to ' + shortDate(end))); }
      if (HOL[d]) dd.appendChild(el('i', '', 'Stat holiday'));
      var w = el('span', 'w');
      if (a.k === 'or') { var r = roomNode(a.room); r.className = ''; w.appendChild(r); }
      else w.textContent = a.label;
      kids(li, dd, w, a.time ? el('span', 't', a.time) : null);
      ol.appendChild(li);
      d = add(end, 1);
    }
    wrap.appendChild(ol);
    if (to < LAST) wrap.appendChild(button('more', 'Show four more weeks', 'data-more'));
    frag.appendChild(wrap);
    return frag;
  }

  // ---- the calendar (3.1): the schedule already on the phone, over many days, in three layouts.
  // Days is one continuous list from a chosen date; Week is every member against Monday to Friday;
  // Month shows the reader's own assignment under each date and, below, everyone on the chosen date.
  // Nothing new is asked of the calendar service: every layout draws the reading the day view uses.
  var STORE_CAL = 'vjhToday.cal', CAL_FIRST_DAYS = 21, CAL_MORE_DAYS = 28;
  var THEME = { day: ['#FEFAE7', '#00313C'], cal: ['#00313C', '#016379'] };   // browser bar colour: [light, dark]
  var SHORT = { daycall: 'Day', nightcall: 'Night', pac2: 'PAC2', post: 'Post', vacation: 'Vac', dayoff: 'Off', closure: 'Closed', flagged: 'Check' };
  var calRefs = null, calWatch = null, calFrame = 0;

  function calKind(s) { return s === 'week' || s === 'month' ? s : 'days'; }
  // The calendar's header is a solid band, so the page loses its top padding and the browser's own bar takes the band's colour.
  function chrome(cal) {
    app.className = 'wrap' + (cal ? ' cal' : '');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var dark = /dark/.test(metas[i].getAttribute('media') || '');
      metas[i].setAttribute('content', THEME[cal ? 'cal' : 'day'][dark ? 1 : 0]);
    }
  }
  function monthTitle(iso) { return MON[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); }
  function monthStart(iso) { return iso.slice(0, 8) + '01'; }
  function addMonths(iso, n) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1 + n, d = +iso.slice(8, 10);
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + '-' + pad(m + 1) + '-' + pad(Math.min(d, last));
  }
  function mondayOf(iso) { return add(iso, -((dow(iso) + 6) % 7)); }
  // The date the calendar is showing: in Days, the day at the top of the screen; otherwise the chosen date.
  function calShown() { return state.cal === 'days' ? (state.calTop || state.calDate) : state.calDate; }
  // A cell in a few letters, for the grids. An operating room is its service's first word; the surgeon is in the day view.
  function abbr(x) {
    var k = kindOf(x);
    if (k === 'gap') return '';
    if (k === 'none') return '–';
    if (k === 'or') {
      var p = splitRoom(x[1]), w = String(p[0] || p[1] || 'OR').trim().split(/\s+/)[0] || 'OR';
      return w.length > 4 ? w.slice(0, 4) : w;
    }
    return SHORT[k] || 'Check';
  }
  function fullText(x) {
    var k = kindOf(x);
    if (k === 'gap') return 'Schedule unavailable';
    if (k === 'none') return 'Nothing listed';
    if (k === 'or') return (x[1] || 'Room not yet named') + ', ' + span(x[2], x[3]);
    if (k === 'flagged') return 'Check the Sheet: “' + x[1] + '”';
    return (LABEL[k] || x[1]) + (x[2] ? ', ' + span(x[2], x[3]) : '');
  }
  function calGo(iso) {
    state.calDate = iso; state.calTop = iso; state.calEnd = null;
    render(); window.scrollTo(0, 0);
  }

  // The title doubles as the date chooser, as the day view's date does.
  function calPick(text) {
    var lab = el('label', 'cpick'), inp = el('input'), ttl = el('span', 'ctitle', text);
    inp.type = 'date'; inp.min = FIRST; inp.max = LAST; inp.value = calShown();
    inp.setAttribute('aria-label', 'Choose a date');
    inp.addEventListener('change', function () { if (validIso(inp.value)) calGo(clamp(inp.value)); });
    inp.addEventListener('click', function () { try { if (inp.showPicker) inp.showPicker(); } catch (err) { /* the native tap still opens it */ } });
    kids(lab, inp, ttl);
    return { node: lab, title: ttl, input: inp };
  }
  function calStep(ch, iso, label, ok) {
    var b = button('cstep', ch);
    b.setAttribute('data-cgo', clamp(iso)); b.setAttribute('aria-label', label);
    b.disabled = !ok;
    return b;
  }
  function calStrip(iso) {
    var wk = el('nav', 'week'), t = todayIso(), mon = mondayOf(iso);
    wk.setAttribute('aria-label', 'Week');
    var prev = button('step', '‹'); prev.setAttribute('data-cgo', clamp(add(iso, -7))); prev.setAttribute('aria-label', 'Previous week');
    prev.disabled = iso <= FIRST;
    wk.appendChild(prev);
    for (var i = 0; i < 7; i++) {
      var d = add(mon, i), gap = inRange(d) && !has(d);
      var b = button('day' + (d === iso ? ' sel' : '') + (d === t ? ' today' : '') + (HOL[d] ? ' hol' : '') + (gap ? ' gap' : ''));
      b.setAttribute('data-cgo', d);
      b.setAttribute('aria-label', WD[dow(d)] + ' ' + longDate(d) + (HOL[d] ? ', statutory holiday' : '') + (gap ? ', schedule unavailable' : ''));
      if (d === iso) b.setAttribute('aria-current', 'date');
      b.disabled = !inRange(d);
      kids(b, el('span', 'l', 'MTWTFSS'.charAt(i)), el('span', 'n', String(+d.slice(8, 10))));
      wk.appendChild(b);
    }
    var next = button('step', '›'); next.setAttribute('data-cgo', clamp(add(iso, 7))); next.setAttribute('aria-label', 'Next week');
    next.disabled = iso >= LAST;
    wk.appendChild(next);
    return wk;
  }
  function calHead() {
    var head = el('header', 'calhead'), row = el('div', 'crow'), seg = el('div', 'seg');
    row.appendChild(button('clink', '‹ Day view', 'data-cal-exit'));
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Calendar layout');
    [['days', 'Days'], ['week', 'Week'], ['month', 'Month']].forEach(function (v) {
      var b = button(v[0] === state.cal ? 'on' : '', v[1]);
      b.setAttribute('data-cal', v[0]); b.setAttribute('aria-pressed', v[0] === state.cal ? 'true' : 'false');
      seg.appendChild(b);
    });
    row.appendChild(seg); head.appendChild(row);
    calRefs = { head: head };
    var row2 = el('div', 'crow'), p;
    if (state.cal === 'days') {
      p = calPick(monthTitle(calShown()));
      kids(row2, p.node, el('span', 'cread', 'Read ' + readWhen()));
      head.appendChild(row2);
      calRefs.title = p.title; calRefs.input = p.input;
      calRefs.strip = calStrip(calShown());
      head.appendChild(calRefs.strip);
    } else if (state.cal === 'week') {
      var mon = mondayOf(state.calDate), fri = add(mon, 4);
      p = calPick((mon.slice(0, 7) === fri.slice(0, 7) ? String(+mon.slice(8, 10)) : dayMonth(mon)) + ' – ' + dayMonth(fri) + ' ' + fri.slice(0, 4));
      row2.className = 'crow cnav';
      kids(row2, calStep('‹', add(state.calDate, -7), 'Previous week', add(mon, -1) >= FIRST), p.node,
        calStep('›', add(state.calDate, 7), 'Next week', add(mon, 7) <= LAST));
      head.appendChild(row2);
    } else {
      var ms = monthStart(state.calDate);
      p = calPick(monthTitle(state.calDate));
      row2.className = 'crow cnav';
      kids(row2, calStep('‹', addMonths(state.calDate, -1), 'Previous month', add(ms, -1) >= FIRST), p.node,
        calStep('›', addMonths(state.calDate, 1), 'Next month', addMonths(ms, 1) <= LAST));
      head.appendChild(row2);
    }
    return head;
  }

  // One day, compactly: call, rooms and clinic as rows (name, assignment, hours); everyone else in a sentence.
  function calRow(m, what, time) {
    return kids(el('li', m === D.me ? 'me' : ''), who(m), kids(el('span', 'w'), what, time ? el('span', 't', time) : null));
  }
  function calNames(arr) { return arr.map(function (c) { return D.members[c.m]; }).join(', '); }
  function calDayBody(iso, extra) {
    var body = el('div', 'cbody');
    if (!has(iso)) { body.appendChild(el('p', 'ctail', 'Schedule unavailable: the Sheet has no column for this date.')); return body; }
    var by = { daycall: [], nightcall: [], or: [], pac2: [], post: [], vacation: [], dayoff: [], closure: [], flagged: [], none: [] };
    D.members.forEach(function (_, m) { var x = cell(iso, m); (by[kindOf(x)] || by.flagged).push({ m: m, x: x }); });
    if (HOL[iso]) body.appendChild(el('p', 'cnote hol', 'Statutory holiday'));
    if (LATE[iso]) body.appendChild(el('p', 'cnote', 'Late-start Thursday: rooms open at 0830'));
    var g, calls = by.daycall.concat(by.nightcall);
    if (calls.length) {
      g = el('ul', 'cg call');
      calls.forEach(function (c) { g.appendChild(calRow(c.m, el('span', 'what', LABEL[c.x[0]]), span(c.x[2], c.x[3]))); });
      body.appendChild(g);
    }
    if (by.or.length) {
      by.or.sort(function (a, b) { return a.x[1] < b.x[1] ? -1 : a.x[1] > b.x[1] ? 1 : a.m - b.m; });
      var hours = {};
      by.or.forEach(function (c) { hours[span(c.x[2], c.x[3])] = true; });
      var one = Object.keys(hours).length === 1;
      g = el('ul', 'cg or');
      by.or.forEach(function (c) { g.appendChild(calRow(c.m, roomNode(c.x[1]), one ? '' : span(c.x[2], c.x[3]))); });
      body.appendChild(g);
    }
    if (by.pac2.length) {
      g = el('ul', 'cg pac2');
      by.pac2.forEach(function (c) { g.appendChild(calRow(c.m, el('span', 'what', 'PAC2 clinic'), span(c.x[2], c.x[3]))); });
      body.appendChild(g);
    }
    if (by.flagged.length) {
      g = el('ul', 'cg flag');
      by.flagged.forEach(function (c) { g.appendChild(calRow(c.m, el('span', 'what', c.x ? 'Check the Sheet: “' + c.x[1] + '”' : 'Check the Sheet'), '')); });
      body.appendChild(g);
    }
    var tail = [];
    if (by.post.length) tail.push('Post call: ' + calNames(by.post));
    if (by.vacation.length) tail.push('Vacation: ' + calNames(by.vacation));
    if (by.dayoff.length) tail.push('Day off: ' + calNames(by.dayoff));
    if (by.closure.length) tail.push('OR closure: ' + calNames(by.closure));
    if (tail.length) body.appendChild(el('p', 'ctail', tail.join('. ') + '.'));
    if (by.none.length === D.members.length) body.appendChild(el('p', 'ctail', 'Nothing is listed in the Sheet for this day.'));
    if (extra) body.appendChild(el('p', 'ctail', extra));
    return body;
  }
  // A Saturday whose Sunday reads exactly the same for every member (the usual weekend) is shown once for both days.
  function sameWeekend(sat) {
    var sun = add(sat, 1);
    if (dow(sat) !== 6 || !has(sat) || !has(sun) || !!HOL[sat] !== !!HOL[sun]) return false;
    var a = D.cells[idx[sat]], b = D.cells[idx[sun]];
    for (var m = 0; m < a.length; m++) {
      if (a[m] === b[m]) continue;
      var x = D.info[a[m]], y = D.info[b[m]];
      if (!x || !y || x.join('\u0001') !== y.join('\u0001')) return false;
    }
    return true;
  }
  function calSection(iso, merged) {
    var sun = merged ? add(iso, 1) : '', t = todayIso(), today = iso === t || sun === t;
    var sec = el('section', 'cday' + (today ? ' today' : '') + (HOL[iso] ? ' hol' : ''));
    sec.setAttribute('data-day', iso);
    var b = button('cdate');
    b.setAttribute('data-cal-day', sun === t ? sun : iso);
    b.setAttribute('aria-label', (merged ? 'Saturday ' + longDate(iso) + ' and Sunday ' + longDate(sun) : WD[dow(iso)] + ' ' + longDate(iso)) + ', open in the day view');
    kids(b, el('span', 'wd', merged ? 'Sat–Sun' : WDS[dow(iso)]),
      el('span', 'n' + (merged ? ' two' : ''), (+iso.slice(8, 10)) + (merged ? '–' + (+sun.slice(8, 10)) : '')),
      today ? el('span', 'td', 'Today') : null);
    return kids(sec, b, calDayBody(iso, merged ? 'The same on both days.' : ''));
  }
  // The days from one date to another, as sections; next is the first day not drawn (a shared weekend is never split).
  function buildDays(from, to) {
    var frag = document.createDocumentFragment(), d = from;
    while (d <= to && d <= LAST) {
      var merged = sameWeekend(d);
      if (d !== state.calDate && (d.slice(8) === '01' || (merged && add(d, 1).slice(8) === '01'))) {
        frag.appendChild(el('h2', 'cmonth', monthTitle(merged ? add(d, 1) : d)));
      }
      frag.appendChild(calSection(d, merged));
      d = add(d, merged ? 2 : 1);
    }
    return { frag: frag, next: d };
  }
  // The end of the list: a button for more days, pressed by itself as it nears the screen, or where the schedule ends.
  function calTail() {
    if (calWatch) { calWatch.disconnect(); calWatch = null; }
    var node;
    if (state.calEnd > LAST) node = el('p', 'empty', 'The schedule ends on ' + shortDate(LAST) + ' ' + LAST.slice(0, 4) + '.');
    else {
      node = button('more', 'Show more days', 'data-cal-more');
      if (window.IntersectionObserver) {
        calWatch = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) { calMore(); return; }
        }, { rootMargin: '600px 0px' });
        calWatch.observe(node);
      }
    }
    calRefs.more = node;
    return node;
  }
  function calMore() {
    if (!D || state.cal !== 'days' || state.person != null || !calRefs || !calRefs.list || !state.calEnd || state.calEnd > LAST) return;
    var r = buildDays(state.calEnd, add(state.calEnd, CAL_MORE_DAYS - 1));
    state.calEnd = r.next;
    calRefs.list.appendChild(r.frag);
    var old = calRefs.more, fresh = calTail();
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
  }
  function calDays() {
    var wrap = el('div', 'cdays'), listEl = el('div', 'clist');
    if (state.calDate > FIRST) wrap.appendChild(button('more cearlier', 'Show the week before', 'data-cal-earlier'));
    var r = buildDays(state.calDate, state.calEnd ? add(state.calEnd, -1) : add(state.calDate, CAL_FIRST_DAYS - 1));
    state.calEnd = r.next;
    listEl.appendChild(r.frag);
    calRefs.list = listEl;
    return kids(wrap, listEl, calTail());
  }
  // Adds the seven days before the list's first day, and leaves the day that was first where it was on screen.
  function calEarlier() {
    var old = state.calDate;
    state.calDate = clamp(add(old, -7)); state.calTop = old;
    render();
    var sec = app.querySelector('.cday[data-day="' + old + '"]');
    if (sec && calRefs) window.scrollTo(0, Math.max(0, sec.getBoundingClientRect().top + window.scrollY - calRefs.head.offsetHeight));
    else window.scrollTo(0, 0);
    calSync();
  }
  // While the list scrolls, the header follows the day at the top of the screen: its month, and its place in the week.
  function calSync() {
    calFrame = 0;
    if (!D || state.cal !== 'days' || state.person != null || !calRefs || !calRefs.list || !calRefs.strip) return;
    var edge = calRefs.head.getBoundingClientRect().bottom + 16, secs = calRefs.list.children, top = null;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i].hasAttribute('data-day') && secs[i].getBoundingClientRect().bottom > edge) { top = secs[i].getAttribute('data-day'); break; }
    }
    if (!top || top === state.calTop) return;
    state.calTop = top;
    calRefs.title.textContent = monthTitle(top);
    calRefs.input.value = top;
    var strip = calStrip(top);
    calRefs.strip.parentNode.replaceChild(strip, calRefs.strip);
    calRefs.strip = strip;
  }
  window.addEventListener('scroll', function () {
    if (!calFrame && D && state.cal === 'days' && state.person == null) {
      calFrame = window.requestAnimationFrame ? window.requestAnimationFrame(calSync) : setTimeout(calSync, 50);
    }
  }, { passive: true });

  function callText(d) {
    if (!has(d)) return 'Schedule unavailable.';
    var day = [], night = [];
    D.members.forEach(function (_, m) {
      var x = cell(d, m);
      if (x && (x[0] === 'daycall' || x[0] === 'nightcall')) (x[0] === 'daycall' ? day : night).push(LABEL[x[0]] + ' ' + D.members[m] + ' ' + span(x[2], x[3]));
    });
    var out = day.concat(night);
    return out.length ? out.join('. ') + '.' : 'No call listed.';
  }
  function calWeek() {
    var mon = mondayOf(state.calDate), sat = add(mon, 5), sun = add(mon, 6), t = todayIso(), busy = false, i;
    // A weekend with rooms or clinic listed gets its own columns; the usual weekend, call only, is a line below.
    [sat, sun].forEach(function (d) {
      if (!has(d)) return;
      D.members.forEach(function (_, m) { var k = kindOf(cell(d, m)); if (k === 'or' || k === 'pac2' || k === 'flagged') busy = true; });
    });
    var n = busy ? 7 : 5, wrap = el('div', 'cweekview'), box = el('div', 'wkscroll'), table = el('table', 'wk' + (busy ? ' wide' : ''));
    wrap.setAttribute('data-day', inRange(mon) ? mon : state.calDate);
    var thead = el('thead'), tr = el('tr'), corner = el('th');
    corner.setAttribute('scope', 'col'); corner.appendChild(el('span', 'sr', 'Name'));
    tr.appendChild(corner);
    for (i = 0; i < n; i++) {
      var d = add(mon, i), th = el('th', (d === t ? 'today' : '') + (HOL[d] ? ' hol' : '')), b = button('wkday');
      th.setAttribute('scope', 'col');
      b.setAttribute('data-cal-day', d); b.disabled = !inRange(d);
      b.setAttribute('aria-label', WD[dow(d)] + ' ' + longDate(d) + (HOL[d] ? ', statutory holiday' : '') + ', open in the day view');
      kids(b, el('span', 'l', WDS[dow(d)]), el('span', 'n', String(+d.slice(8, 10))));
      th.appendChild(b); tr.appendChild(th);
    }
    thead.appendChild(tr); table.appendChild(thead);
    var tb = el('tbody');
    D.members.forEach(function (_, m) {
      var r = el('tr', m === D.me ? 'me' : ''), h = el('th');
      h.setAttribute('scope', 'row'); h.appendChild(who(m)); r.appendChild(h);
      for (var j = 0; j < n; j++) {
        var x = cell(add(mon, j), m), td = el('td'), c = el('span', 'c k-' + kindOf(x), abbr(x));
        if (x) c.title = fullText(x);
        td.appendChild(c); r.appendChild(td);
      }
      tb.appendChild(r);
    });
    table.appendChild(tb); box.appendChild(table); wrap.appendChild(box);
    if (!busy && (inRange(sat) || inRange(sun))) {
      var a = callText(sat), z = callText(sun), lines = [];
      if (inRange(sat) && inRange(sun) && a === z) lines.push([sat, 'Sat ' + dayMonth(sat) + ' and Sun ' + dayMonth(sun), a]);
      else { if (inRange(sat)) lines.push([sat, shortDate(sat), a]); if (inRange(sun)) lines.push([sun, shortDate(sun), z]); }
      lines.forEach(function (l) {
        var p = el('p', 'wkend'), lb = button('link', l[1]);
        lb.setAttribute('data-cal-day', l[0]);
        kids(p, lb, document.createTextNode(' ' + l[2]));
        wrap.appendChild(p);
      });
    }
    return wrap;
  }

  function calMonth() {
    var sel = state.calDate, ym = sel.slice(0, 7), t = todayIso(), wrap = el('div', 'cmonthview');
    wrap.setAttribute('data-day', sel);
    var hd = el('div', 'mgrid mhead'), grid = el('div', 'mgrid'), d = mondayOf(monthStart(sel)), i;
    hd.setAttribute('aria-hidden', 'true');
    for (i = 0; i < 7; i++) hd.appendChild(el('span', '', 'MTWTFSS'.charAt(i)));
    do {
      for (i = 0; i < 7; i++) {
        var x = D.me >= 0 ? cell(d, D.me) : undefined, k = D.me >= 0 ? kindOf(x) : 'gap', gap = inRange(d) && !has(d);
        var mine = (k === 'gap' || k === 'none') ? '' : abbr(x);
        var b = button('mday' + (d === sel ? ' sel' : '') + (d === t ? ' today' : '') + (HOL[d] ? ' hol' : '') + (d.slice(0, 7) !== ym ? ' out' : '') + (gap ? ' gap' : ''));
        b.setAttribute('data-cgo', d);
        b.setAttribute('aria-label', WD[dow(d)] + ' ' + longDate(d) + (d === t ? ', today' : '') + (HOL[d] ? ', statutory holiday' : '') +
          (gap ? ', schedule unavailable' : '') + (mine ? ', you: ' + fullText(x) : ''));
        if (d === sel) b.setAttribute('aria-current', 'date');
        b.disabled = !inRange(d);
        kids(b, el('span', 'n', String(+d.slice(8, 10))), el('span', 'c k-' + k, mine || ' '));
        grid.appendChild(b);
        d = add(d, 1);
      }
    } while (d.slice(0, 7) === ym);
    kids(wrap, hd, grid, el('p', 'ctail mcap', D.me >= 0 ? 'Each date shows your own assignment. Tap a date for everyone that day.' : 'Tap a date for everyone that day.'));
    var panel = el('section', 'mpanel'), ph = el('div', 'mhd'), open = button('link', 'Open in the day view');
    open.setAttribute('data-cal-day', sel);
    kids(ph, el('h2', '', WD[dow(sel)] + ' ' + (+sel.slice(8, 10)) + ' ' + MON[+sel.slice(5, 7) - 1]), open);
    kids(panel, ph, calDayBody(sel, ''));
    wrap.appendChild(panel);
    return wrap;
  }

  function calView() {
    if (!inRange(state.calDate)) { state.calDate = clamp(todayIso()); state.calTop = null; state.calEnd = null; }
    if (state.calTop && !inRange(state.calTop)) state.calTop = null;
    if (state.calEnd && state.calEnd <= state.calDate) state.calEnd = null;
    state.cal = calKind(state.cal);
    var main = el('main', 'calview');
    main.appendChild(calHead());
    main.appendChild(state.cal === 'week' ? calWeek() : state.cal === 'month' ? calMonth() : calDays());
    main.appendChild(footer('Tap a date to open that day in the day view. Tap a name for that person’s next four weeks.'));
    return main;
  }

  // ---- render and events
  function render(dir) {
    app.textContent = '';
    nowBox = null; calRefs = null;
    if (calWatch) { calWatch.disconnect(); calWatch = null; }
    chrome(!!state.cal && state.person == null);
    if (D.preview) app.appendChild(el('p', 'ribbon', D.preview));
    staleBox = staleNotice();
    if (staleBox) app.appendChild(staleBox);
    // A one-time note, such as why a person's four weeks closed; the next render clears it.
    if (state.notice) {
      var nt = el('p', 'notice', state.notice);
      nt.setAttribute('role', 'status');
      app.appendChild(nt);
      state.notice = null;
    }
    if (state.person != null) { app.appendChild(personView()); return; }
    if (state.cal) { app.appendChild(calView()); return; }
    var main = el('main', dir ? 'in-' + dir : '');
    main.appendChild(header(state.date));
    if (state.date === todayIso() && inRange(state.date)) { nowBox = nowBand(); main.appendChild(nowBox); }
    main.appendChild(dayBody(state.date));
    main.appendChild(footer());
    app.appendChild(main);
  }
  function renderInPlace() { var y = window.scrollY; render(); window.scrollTo(0, y); }

  app.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-m],[data-go],[data-back],[data-more],[data-refresh],[data-retry],[data-paste],[data-cal-open],[data-cal-exit],[data-cal],[data-cgo],[data-cal-day],[data-cal-more],[data-cal-earlier]') : null;
    if (!t || t.disabled) return;
    if (t.hasAttribute('data-paste')) { askForLink(''); return; }
    if (t.hasAttribute('data-refresh') || t.hasAttribute('data-retry')) { if (D) refresh(); else load(); return; }
    if (!D) return;
    var ci;
    if (t.hasAttribute('data-cal-open')) {
      state.cal = calKind(recall(STORE_CAL));
      state.calDate = inRange(state.date) ? state.date : clamp(todayIso());
      state.calTop = state.calDate; state.calEnd = null;
      render(); window.scrollTo(0, 0); return;
    }
    if (t.hasAttribute('data-cal-exit')) { state.cal = null; render(); window.scrollTo(0, 0); return; }
    if (t.hasAttribute('data-cal-day')) {
      ci = t.getAttribute('data-cal-day');
      if (!inRange(ci)) return;
      state.cal = null; go(ci); window.scrollTo(0, 0); return;
    }
    if (t.hasAttribute('data-cal')) {
      ci = calShown();
      state.cal = calKind(t.getAttribute('data-cal')); store(STORE_CAL, state.cal);
      state.calDate = ci; state.calTop = ci; state.calEnd = null;
      render(); window.scrollTo(0, 0); return;
    }
    if (t.hasAttribute('data-cgo')) {
      ci = t.getAttribute('data-cgo');
      if (!inRange(ci) || !state.cal) return;
      if (state.cal === 'days') calGo(ci);
      else { state.calDate = ci; state.calTop = ci; renderInPlace(); }
      return;
    }
    if (t.hasAttribute('data-cal-more')) { calMore(); return; }
    if (t.hasAttribute('data-cal-earlier')) { calEarlier(); return; }
    if (t.hasAttribute('data-go')) { var iso = t.getAttribute('data-go'); go(iso, iso > state.date ? 'l' : 'r'); return; }
    if (t.hasAttribute('data-m')) {
      state.dayScroll = window.scrollY;
      state.person = +t.getAttribute('data-m');
      state.personName = D.members[state.person];
      // From the calendar, the four weeks begin on the day the name was tapped in.
      var sec = state.cal && t.closest('[data-day]'), secDay = sec ? sec.getAttribute('data-day') : '';
      state.from = inRange(secDay) ? secDay : inRange(state.date) ? state.date : todayIso();
      state.weeks = 1;
      render(); window.scrollTo(0, 0); return;
    }
    if (t.hasAttribute('data-back')) { state.person = null; state.personName = null; render(); window.scrollTo(0, state.dayScroll); return; }
    if (t.hasAttribute('data-more')) { var y = window.scrollY; state.weeks++; render(); window.scrollTo(0, y); }
  });

  document.addEventListener('keydown', function (e) {
    if (!D || state.person != null || state.cal || (e.target && e.target.tagName === 'INPUT')) return;
    if (e.key === 'ArrowLeft') go(add(state.date, -1), 'r');
    if (e.key === 'ArrowRight') go(add(state.date, 1), 'l');
  });

  var sx = null, sy = null;
  app.addEventListener('touchstart', function (e) { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
  app.addEventListener('touchend', function (e) {
    if (sx == null || !D || state.person != null || state.cal) return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 45) go(add(state.date, dx < 0 ? 1 : -1), dx < 0 ? 'l' : 'r');
  }, { passive: true });

  // Every 30 seconds: keep "on call now" current, follow midnight, and refresh once the reading is old.
  function tick() {
    if (!D || loading) return;
    var t = todayIso();
    if (t !== lastToday) {
      // Midnight passed. "Today", the week strip's marker and the on-call band all depend on the
      // date, so re-render: the band then appears only on the new today, never beside another
      // day's assignments.
      lastToday = t;
      if (followToday && inRange(t)) state.date = t;
      renderInPlace();
    } else {
      if (nowBox && nowBox.parentNode && state.date === t) { var fresh = nowBand(); nowBox.parentNode.replaceChild(fresh, nowBox); nowBox = fresh; }
      if (!staleBox) { var s = staleNotice(); if (s) { staleBox = s; app.insertBefore(s, app.firstChild); } }
    }
    if (!PREVIEW && !document.hidden && Date.now() - D.readAt >= STALE_MS && Date.now() - lastTry >= STALE_MS) refresh();
  }
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !D) return;
    tick();
    if (!PREVIEW && !loading && Date.now() - lastTry >= RESUME_MS) refresh();
  });

  // ---- loading, refreshing and failing
  function showLoading() {
    chrome(false);
    app.innerHTML = LOADING_HTML;
    window.scrollTo(0, 0);
  }
  function showError(msg) {
    // Block navigation and ticks from bringing back a snapshot after a refusal.
    D = null; idx = {}; HOL = {}; LATE = {}; FIRST = ''; LAST = '';
    nowBox = null; staleBox = null; started = false;
    chrome(false);
    app.textContent = '';
    var box = el('div', 'loading');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', 'brand', 'VJH Anesthesia'));
    box.appendChild(el('p', 'load-err', msg));
    if (validKey(K)) box.appendChild(button('more', 'Try again', 'data-retry'));
    box.appendChild(button('alt', 'Use a different link', 'data-paste'));
    app.appendChild(box);
  }
  // A temporary failure keeps the schedule already on screen, marked as not refreshed; with nothing
  // on screen yet it is an error.
  function failSoft(msg) {
    if (!D) { showError(msg); return; }
    refreshFailed = true;
    renderInPlace();
  }
  // A refusal (link retired, no longer on the schedule, not a valid link) clears the schedule, here
  // and in the phone's storage.
  function failHard(msg) {
    refreshFailed = false;
    forget(K);
    showError(msg);
  }
  function start(d) {
    refreshFailed = false;
    // Roster order may change between reads. Keep the person by name, not old index.
    var selected = state.personName;
    var again = started;
    setData(d);
    if (state.person != null) {
      var match = -1;
      D.members.forEach(function (name, i) {
        if (selected && name.toLowerCase() === selected.toLowerCase()) match = i;
      });
      state.person = match >= 0 ? match : null;
      state.personName = match >= 0 ? D.members[match] : null;
      if (match < 0) {
        state.from = null; state.weeks = 1; state.dayScroll = 0;
        if (selected) state.notice = selected + ' is no longer on the schedule.';
      }
    }
    if (!started) {
      started = true;
      var startGiven = inRange(START_DATE);
      state.date = clamp(startGiven ? START_DATE : todayIso());
      followToday = !startGiven;
      lastToday = todayIso();
    } else if (!inRange(state.date)) {
      state.date = clamp(todayIso());
      state.person = null; state.personName = null;
    }
    if (again) renderInPlace(); else render();
  }
  function done(r) {
    loading = false; refreshing = false;
    clearTimeout(slowTimer);
    if (r.data) {
      store(STORE_KEY, K);
      store(STORE_DATA, JSON.stringify({ k: K, data: r.data, savedAt: Date.now() }));
      start(r.data);
    } else if (r.temporary === true) failSoft(r.error);
    else failHard(r.error);
  }
  // Nothing on screen yet: show the spinner while asking.
  function load() {
    if (loading) return;
    loading = true;
    lastTry = Date.now();
    showLoading();
    slowTimer = setTimeout(function () {
      var m = app.querySelector('.load-msg');
      if (loading && m) m.textContent = 'Still reading the schedule. This can take a little longer on a slow connection.';
    }, SLOW_MS);
    if (PREVIEW) {
      var p = PREVIEW;
      setTimeout(function () { loading = false; clearTimeout(slowTimer); start(p); }, p.previewDelay > 0 ? p.previewDelay : 0);
      return;
    }
    var mine = ++seq;
    ask(K).then(function (r) { if (mine === seq) done(r); });
  }
  // A schedule already on screen: keep showing it while asking, and redraw in place when the answer comes.
  function refresh() {
    if (loading) return;
    if (!D) { load(); return; }
    if (PREVIEW) { renderInPlace(); return; }
    loading = true; refreshing = true;
    lastTry = Date.now();
    renderInPlace();
    var mine = ++seq;
    ask(K).then(function (r) { if (mine === seq) done(r); });
  }

  // ---- whose page: the link's key, else the one kept from an earlier visit, else ask for the link
  function linkParts() {
    var parse = function (s) {
      var o = {};
      s.replace(/^[#?]/, '').split('&').forEach(function (kv) {
        var i = kv.indexOf('='); if (i < 1) return;
        var name = kv.slice(0, i), v = kv.slice(i + 1);
        try { v = decodeURIComponent(v); } catch (err) { /* left as it is */ }
        if (!(name in o)) o[name] = v;
      });
      return o;
    };
    var h = parse(location.hash), q = parse(location.search);
    return { k: String(h.k || q.k || '').trim().toLowerCase(), date: h.date || q.date || '', inQuery: !h.k && !!q.k };
  }
  function keyFromText(s) {
    var m = String(s || '').trim().match(/(?:^|[#?&]k=)([0-9a-fA-F]{32})(?![0-9a-fA-F])/);
    return m ? m[1].toLowerCase() : '';
  }
  function askForLink(problem) {
    seq++; clearTimeout(slowTimer);
    D = null; started = false; loading = false; refreshing = false;
    chrome(false);
    app.textContent = '';
    var box = el('div', 'loading');
    var form = el('div', 'paste');
    var icon = el('img', 'icon'); icon.src = 'icons/apple-touch-icon.png'; icon.alt = ''; icon.width = 64; icon.height = 64;
    form.appendChild(icon);
    form.appendChild(el('h1', '', 'VJH Anesthesia: Today'));
    form.appendChild(el('p', '', 'Open your personal Today page link from the scheduler’s email, or paste it here. This phone keeps it, so next time the page opens straight away.'));
    if (problem) { var e = el('p', 'err', problem); e.setAttribute('role', 'alert'); form.appendChild(e); }
    var lab = el('label', '', 'Your Today page link');
    lab.setAttribute('for', 'vjh-link');
    var inp = el('input'); inp.id = 'vjh-link'; inp.type = 'url'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.setAttribute('autocapitalize', 'off'); inp.placeholder = 'https://…#k=…';
    var go = button('go', 'Open');
    var submit = function () {
      var k = keyFromText(inp.value);
      if (!k) { askForLink('That does not look like a VJH Today link. Copy the whole link from the email and try again.'); return; }
      openKey(k, '');
    };
    go.addEventListener('click', submit);
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
    kids(form, lab, inp, go);
    box.appendChild(form);
    app.appendChild(box);
  }
  function openKey(k, date) {
    seq++; clearTimeout(slowTimer); loading = false; refreshing = false;   // an answer still on its way for another link is ignored
    K = k; LINK_DATE = date || ''; START_DATE = validIso(date) ? date : '';
    state = { date: null, person: null, personName: null, from: null, weeks: 1, dayScroll: 0, notice: null, cal: null, calDate: null, calTop: null, calEnd: null };
    started = false; refreshFailed = false; D = null;
    // Keep the key in the address, after the #: a home screen icon added now opens this person's page.
    var want = '#k=' + k + (START_DATE ? '&date=' + START_DATE : '');
    if (location.hash !== want || location.search) {
      try { history.replaceState(null, '', location.pathname + want); } catch (err) { /* the address stays as it was */ }
    }
    var saved = savedSchedule(k);
    if (saved) { start(saved); refresh(); }
    else load();
  }
  function boot() {
    if (PREVIEW) { load(); return; }
    var p = linkParts();
    if (p.k) {
      if (!validKey(p.k)) { K = ''; forget(p.k); showError(INVALID); return; }
      openKey(p.k, p.date);
      return;
    }
    var kept = recall(STORE_KEY);
    if (validKey(kept)) { openKey(kept, p.date); return; }
    askForLink('');
  }
  // A link opened over this one (pasted into the address bar, so the page does not reload) is followed:
  // another key changes whose page it is, and a date opens that day.
  window.addEventListener('hashchange', function () {
    if (PREVIEW) return;
    var p = linkParts();
    if (!p.k) return;
    if (!validKey(p.k)) { seq++; clearTimeout(slowTimer); loading = false; refreshing = false; K = ''; showError(INVALID); return; }
    if (p.k !== K || p.date !== LINK_DATE) openKey(p.k, p.date);
  });

  // Android browsers install the page as an app from the manifest, which opens the bare address; the
  // kept key covers that. iPhones would use the manifest's address too, and an iPhone home screen app
  // has storage of its own, so it would open without the key: iPhones are not shown the manifest, and
  // Add to Home Screen then keeps the address as it is, key included. Only browsers that can install
  // from a manifest (BeforeInstallPromptEvent) are given it.
  if (!PREVIEW && 'BeforeInstallPromptEvent' in window) {
    var man = document.createElement('link');
    man.rel = 'manifest'; man.href = 'manifest.webmanifest';
    document.head.appendChild(man);
  }
  if (!PREVIEW && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(function (err) { console.error('VJH Today: offline copy unavailable: ' + (err && err.message || err)); });
  }

  boot();
})();
