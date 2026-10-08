(function () {
  'use strict';

  var STORE_KEY = 'pujo-pune-2026';
  var ROAD_FACTOR = 1.3;          // straight-line distance to a rough road distance
  var SPEED_KMH = { drive: 20, walk: 4.5 };
  var TRAVELMODE = { drive: 'driving', walk: 'walking' };
  var LEG_POINTS = 5;             // start + 3 stops + end: the most Google Maps takes in a phone browser
  var EXACT_LIMIT = 13;           // up to this many points every order is checked (Held-Karp)
  var LOCALITY_ZOOM_KM = 14;      // below this map width, label localities instead of areas
  var DESKTOP = window.matchMedia('(min-width: 900px)');
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Constant markup only. Data is always inserted with textContent.
  var ICON = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 13v6h14v-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
  };

  var data, basemap;
  var byId = {}, areaById = {}, cardEls = {}, sectionEls = {}, chipEls = {}, addAllEls = {};
  var state = { route: [], start: 'best', back: false, mode: 'drive', area: 'all', q: '', me: null };
  var plan = null;
  var lastCleared = null;

  // ---------- small helpers

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, parent) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function externalLink(href, className, text) {
    var a = el('a', className, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function withIcon(node, icon, label) {
    node.innerHTML = icon;
    node.appendChild(document.createTextNode(label));
    return node;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function fmtKm(km) { return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + ' km'; }

  function fmtTime(hours) {
    var mins = Math.max(5, Math.round(hours * 60 / 5) * 5);
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---------- distances and the route solver

  function haversine(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function distanceMatrix(points) {
    var n = points.length, D = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) D[i * n + j] = D[j * n + i] = haversine(points[i], points[j]);
    }
    return D;
  }

  // Shortest order through every point.
  // start: index the route must begin at, or -1 to let the solver choose.
  // closed: the route ends back at its first point.
  function solveRoute(D, n, start, closed) {
    if (n === 1) return { order: [0], exact: true };
    if (closed && start < 0) start = 0; // a loop costs the same from any point
    return n <= EXACT_LIMIT ? heldKarp(D, n, start, closed) : localSearch(D, n, start, closed);
  }

  // Exact dynamic programme over subsets: O(n^2 2^n).
  function heldKarp(D, n, start, closed) {
    var size = 1 << n, full = size - 1;
    var cost = new Float64Array(size * n).fill(Infinity);
    var prev = new Int8Array(size * n).fill(-1);
    for (var s = 0; s < n; s++) {
      if (start < 0 || s === start) cost[(1 << s) * n + s] = 0;
    }
    for (var mask = 1; mask < size; mask++) {
      for (var j = 0; j < n; j++) {
        if (!(mask & (1 << j))) continue;
        var c = cost[mask * n + j];
        if (c === Infinity) continue;
        for (var k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          var idx = (mask | (1 << k)) * n + k, v = c + D[j * n + k];
          if (v < cost[idx]) { cost[idx] = v; prev[idx] = j; }
        }
      }
    }
    var best = Infinity, end = -1;
    for (var e = 0; e < n; e++) {
      var total = cost[full * n + e] + (closed ? D[e * n + start] : 0);
      if (total < best) { best = total; end = e; }
    }
    var order = [], m = full, cur = end;
    while (cur !== -1) {
      order.push(cur);
      var p = prev[m * n + cur];
      m &= ~(1 << cur);
      cur = p;
    }
    return { order: order.reverse(), exact: true };
  }

  function pathCost(p, D, n, closed) {
    var c = 0;
    for (var i = 1; i < p.length; i++) c += D[p[i - 1] * n + p[i]];
    if (closed) c += D[p[p.length - 1] * n + p[0]];
    return c;
  }

  function nearestNeighbour(D, n, s) {
    var used = new Uint8Array(n), p = [s];
    used[s] = 1;
    for (var step = 1; step < n; step++) {
      var last = p[p.length - 1], best = -1, bd = Infinity;
      for (var k = 0; k < n; k++) {
        if (!used[k] && D[last * n + k] < bd) { bd = D[last * n + k]; best = k; }
      }
      p.push(best);
      used[best] = 1;
    }
    return p;
  }

  function reverse(p, i, k) {
    while (i < k) { var t = p[i]; p[i] = p[k]; p[k] = t; i++; k--; }
  }

  // Reverse a stretch of the route whenever that makes it shorter.
  function twoOpt(p, D, n, fixed, closed) {
    var improved = false, again = true, len = p.length;
    while (again) {
      again = false;
      for (var i = fixed ? 1 : 0; i < len - 1; i++) {
        for (var k = i + 1; k < len; k++) {
          var a = i > 0 ? p[i - 1] : -1, b = p[i], c = p[k];
          var e = k < len - 1 ? p[k + 1] : (closed ? p[0] : -1);
          var delta = (a >= 0 ? D[a * n + c] - D[a * n + b] : 0) + (e >= 0 ? D[b * n + e] - D[c * n + e] : 0);
          if (delta < -1e-9) { reverse(p, i, k); again = improved = true; }
        }
      }
    }
    return improved;
  }

  // Move a run of 1 to 3 stops to a better place in the route, either way round.
  function orOpt(p, D, n, fixed, closed) {
    var improved = false, len = p.length, lo = fixed ? 1 : 0;
    function d(a, b) { return a < 0 || b < 0 ? 0 : D[a * n + b]; }
    for (var L = 1; L <= 3; L++) {
      for (var i = lo; i + L <= len; i++) {
        var first = p[i], last = p[i + L - 1];
        var before = i > 0 ? p[i - 1] : -1;
        var after = i + L < len ? p[i + L] : (closed ? p[0] : -1);
        var gain = d(before, first) + d(last, after) - d(before, after);
        var rest = p.slice(0, i).concat(p.slice(i + L));
        var rl = rest.length, bestDelta = -1e-9, bestJ = -1, bestRev = false;
        for (var j = lo; j <= rl; j++) {
          if (j === i) continue;
          var u = j > 0 ? rest[j - 1] : -1;
          var v = j < rl ? rest[j] : (closed ? rest[0] : -1);
          var base = d(u, v);
          var fwd = d(u, first) + d(last, v) - base - gain;
          if (fwd < bestDelta) { bestDelta = fwd; bestJ = j; bestRev = false; }
          if (L > 1) {
            var rev = d(u, last) + d(first, v) - base - gain;
            if (rev < bestDelta) { bestDelta = rev; bestJ = j; bestRev = true; }
          }
        }
        if (bestJ >= 0) {
          var seg = p.slice(i, i + L);
          if (bestRev) seg.reverse();
          var np = rest.slice(0, bestJ).concat(seg, rest.slice(bestJ));
          for (var t = 0; t < len; t++) p[t] = np[t];
          improved = true;
        }
      }
    }
    return improved;
  }

  function improve(p, D, n, fixed, closed) {
    var a, b;
    do {
      a = twoOpt(p, D, n, fixed, closed);
      b = orOpt(p, D, n, fixed, closed);
    } while (a || b);
    return p;
  }

  // Seeded so the same picks always give the same order.
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Too many points to check every order: multi-start nearest neighbour,
  // 2-opt and Or-opt, then random double-bridge kicks to escape local minima.
  function localSearch(D, n, start, closed) {
    var fixed = start >= 0;
    var starts = [];
    if (fixed) starts.push(start); else for (var s = 0; s < n; s++) starts.push(s);
    var best = null, bestCost = Infinity;
    starts.forEach(function (s0) {
      var p = improve(nearestNeighbour(D, n, s0), D, n, fixed, closed);
      var c = pathCost(p, D, n, closed);
      if (c < bestCost) { bestCost = c; best = p; }
    });
    var lo = fixed ? 1 : 0, rand = rng(n * 7919 + (closed ? 1 : 0));
    if (n - lo >= 8) {
      for (var it = 0; it < 80; it++) {
        var span = n - lo;
        var cuts = [rand(), rand(), rand()].map(function (r) { return lo + 1 + Math.floor(r * (span - 1)); })
          .sort(function (x, y) { return x - y; });
        if (cuts[0] === cuts[1] || cuts[1] === cuts[2]) continue;
        var q = best.slice(0, cuts[0]).concat(best.slice(cuts[1], cuts[2]), best.slice(cuts[0], cuts[1]), best.slice(cuts[2]));
        improve(q, D, n, fixed, closed);
        var qc = pathCost(q, D, n, closed);
        if (qc < bestCost - 1e-9) { bestCost = qc; best = q; }
      }
    }
    return { order: best, exact: false };
  }

  // ---------- the plan for the current picks

  function computePlan() {
    var stops = state.route.map(function (id) { return byId[id]; }).filter(Boolean);
    if (!stops.length) return null;
    var fromMe = state.start === 'me' && !!state.me;
    var points = stops.map(function (p) { return p.pos; });
    if (fromMe) points.unshift(state.me);
    var n = points.length, D = distanceMatrix(points);
    var closed = state.back && n > 1;
    var res = solveRoute(D, n, fromMe ? 0 : -1, closed);
    var order = res.order;

    var ordered = [], legKm = [], total = 0;
    for (var i = 0; i < order.length; i++) {
      var km = i > 0 ? D[order[i - 1] * n + order[i]] * ROAD_FACTOR : 0;
      total += km;
      if (fromMe && i === 0) continue;
      ordered.push(stops[fromMe ? order[i] - 1 : order[i]]);
      legKm.push(km);
    }
    var backKm = closed ? D[order[n - 1] * n + order[0]] * ROAD_FACTOR : 0;
    total += backKm;

    var index = {};
    ordered.forEach(function (p, k) { index[p.id] = k + 1; });
    return { stops: ordered, legKm: legKm, backKm: backKm, closed: closed, km: total, exact: res.exact, fromMe: fromMe, index: index };
  }

  function mapsParam(p) { return p.pos_exact ? p.pos[0] + ',' + p.pos[1] : p.maps_query; }

  function directionsUrl(origin, destination, waypoints) {
    var q = ['api=1'];
    if (origin) q.push('origin=' + encodeURIComponent(origin));
    q.push('destination=' + encodeURIComponent(destination));
    if (waypoints.length) q.push('waypoints=' + waypoints.map(encodeURIComponent).join('%7C'));
    q.push('travelmode=' + TRAVELMODE[state.mode]);
    return 'https://www.google.com/maps/dir/?' + q.join('&');
  }

  // Google Maps takes a handful of stops per link on phones, so long routes
  // become legs, each starting where the previous one ended.
  function buildLegs(pl) {
    var pts = [];
    if (pl.fromMe) pts.push({ param: null, label: 'you' }); // no origin: Google starts from where you are
    pl.stops.forEach(function (p, i) { pts.push({ param: mapsParam(p), label: 'stop ' + (i + 1) }); });
    if (pl.closed) pts.push({ param: pl.fromMe ? state.me.join(',') : pts[0].param, label: 'start' });
    if (pts.length === 1) return [{ text: 'Open in Google Maps', url: directionsUrl(null, pts[0].param, []) }];
    var legs = [];
    for (var a = 0, b; a < pts.length - 1; a = b) {
      b = Math.min(a + LEG_POINTS - 1, pts.length - 1);
      legs.push({
        text: cap(pts[a].label) + ' to ' + pts[b].label,
        url: directionsUrl(pts[a].param, pts[b].param, pts.slice(a + 1, b).map(function (x) { return x.param; }))
      });
    }
    if (legs.length === 1) legs[0].text = 'Open the whole route';
    return legs;
  }

  // ---------- list

  function renderChips() {
    var chips = $('chips');
    function chip(id, name, count) {
      var b = el('button', 'chip');
      b.type = 'button';
      b.dataset.area = id;
      b.appendChild(document.createTextNode(name));
      b.appendChild(el('span', 'n', String(count)));
      chipEls[id] = b;
      chips.appendChild(b);
    }
    chip('all', 'All', data.pandals.length);
    data.areas.forEach(function (a) { chip(a.id, a.name, a.count); });
    chips.addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (b) setArea(b.dataset.area, true);
    });
  }

  function renderCard(p, area) {
    var card = el('article', 'card');
    card.dataset.id = p.id;
    card.dataset.q = (p.name + ' ' + p.locality + ' ' + area.name).toLowerCase();

    var stop = el('button', 'stop');
    stop.innerHTML = ICON.plus;
    stop.type = 'button';
    stop.dataset.toggle = p.id;
    card.appendChild(stop);

    card.appendChild(el('h3', null, p.name));
    card.appendChild(el('p', 'loc', p.locality));
    if (p.note) card.appendChild(el('p', 'note', p.note));

    var acts = el('div', 'acts');
    var maps = withIcon(externalLink(p.maps_url, 'act maps'), ICON.pin, 'Maps');
    maps.setAttribute('aria-label', 'Open ' + p.name + ' in Google Maps');
    var share = withIcon(el('button', 'act'), ICON.share, 'Share');
    share.type = 'button';
    share.dataset.share = p.id;
    share.setAttribute('aria-label', 'Share ' + p.name);
    acts.appendChild(maps);
    acts.appendChild(share);
    card.appendChild(acts);

    cardEls[p.id] = card;
    return card;
  }

  function renderList() {
    var root = $('areas');
    root.textContent = '';
    data.areas.forEach(function (area) {
      var pandals = data.pandals.filter(function (p) { return p.area === area.id; });
      var section = el('section', 'area');
      section.id = area.id;
      section.dataset.total = String(pandals.length);

      var head = el('div', 'area-head');
      var h2 = el('h2');
      h2.appendChild(el('span', null, area.name));
      h2.appendChild(el('span', 'count', String(pandals.length)));
      var addAll = el('button', 'add-all');
      addAll.type = 'button';
      addAll.dataset.areaAll = area.id;
      head.appendChild(h2);
      head.appendChild(addAll);
      section.appendChild(head);

      var grid = el('div', 'grid');
      pandals.forEach(function (p) { grid.appendChild(renderCard(p, area)); });
      section.appendChild(grid);

      sectionEls[area.id] = section;
      addAllEls[area.id] = addAll;
      root.appendChild(section);
    });

    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-toggle],[data-share],[data-area-all]');
      if (t && t.dataset.toggle) return toggleStop(t.dataset.toggle);
      if (t && t.dataset.share) return sharePandal(byId[t.dataset.share]);
      if (t && t.dataset.areaAll) return toggleArea(t.dataset.areaAll);
      if (e.target.closest('a,button')) return;
      var card = e.target.closest('.card');
      if (card && DESKTOP.matches) map.focus(card.dataset.id);
    });
  }

  function syncList() {
    data.pandals.forEach(function (p) {
      var n = plan ? plan.index[p.id] || 0 : 0;
      var card = cardEls[p.id], stop = card.firstChild;
      card.classList.toggle('on', !!n);
      if (n) stop.textContent = String(n); else stop.innerHTML = ICON.plus;
      stop.setAttribute('aria-pressed', n ? 'true' : 'false');
      stop.setAttribute('aria-label', n ? 'Stop ' + n + '. Remove ' + p.name + ' from route' : 'Add ' + p.name + ' to route');
    });
    data.areas.forEach(function (a) {
      var ids = idsInArea(a.id), all = ids.every(inRoute);
      addAllEls[a.id].textContent = all ? 'Remove all ' + ids.length + ' from route' : '+ Add all ' + ids.length + ' to route';
    });
  }

  function applyFilter() {
    var term = state.q.trim().toLowerCase(), any = false;
    data.areas.forEach(function (area) {
      var section = sectionEls[area.id];
      if (state.area !== 'all' && state.area !== area.id) { section.hidden = true; return; }
      var matches = 0;
      section.querySelectorAll('.card').forEach(function (card) {
        var show = !term || card.dataset.q.indexOf(term) !== -1;
        card.hidden = !show;
        if (show) matches++;
      });
      section.hidden = matches === 0;
      if (matches) any = true;
      section.querySelector('.count').textContent = term ? matches + ' of ' + section.dataset.total : section.dataset.total;
    });
    $('empty').hidden = any;
    map.dim(function (id) { return cardEls[id].hidden || cardEls[id].closest('section').hidden; });
  }

  function setArea(id, fromUser) {
    state.area = areaById[id] ? id : 'all';
    Object.keys(chipEls).forEach(function (k) { chipEls[k].setAttribute('aria-pressed', k === state.area ? 'true' : 'false'); });
    applyFilter();
    map.fitArea(state.area, fromUser);
    if (fromUser) {
      try { history.replaceState(null, '', state.area === 'all' ? location.pathname + location.search : '#' + state.area); } catch (e) { /* sandboxed */ }
      var chipsBar = document.querySelector('.chips');
      if (chipsBar.getBoundingClientRect().top <= 1) $('areas').scrollIntoView({ block: 'start' });
      chipEls[state.area].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderContacts(meta) {
    var list = $('contacts');
    (meta.contacts || []).forEach(function (c) {
      var li = el('li');
      li.appendChild(el('span', null, c.name));
      li.appendChild(externalLink('https://wa.me/91' + c.phone, null, c.phone));
      list.appendChild(li);
    });
    $('credit').textContent = 'Data collected and compiled by ' + meta.compiled_by + '. An initiative by ' + meta.initiative + '.';
    if (basemap && basemap.attribution) {
      var attr = $('map-attr');
      attr.appendChild(document.createTextNode('City outlines: '));
      attr.appendChild(externalLink(basemap.source_url, null, basemap.attribution));
      attr.appendChild(document.createTextNode('. Pins sit at the centre of each locality until exact pins are added.'));
    }
  }

  // ---------- route picks

  function inRoute(id) { return state.route.indexOf(id) !== -1; }

  function idsInArea(areaId) {
    return data.pandals.filter(function (p) { return p.area === areaId; }).map(function (p) { return p.id; });
  }

  function toggleStop(id) {
    if (inRoute(id)) state.route = state.route.filter(function (x) { return x !== id; });
    else state.route.push(id);
    lastCleared = null;
    update(true);
  }

  function toggleArea(areaId) {
    var ids = idsInArea(areaId);
    if (ids.every(inRoute)) state.route = state.route.filter(function (x) { return ids.indexOf(x) === -1; });
    else ids.forEach(function (id) { if (!inRoute(id)) state.route.push(id); });
    lastCleared = null;
    update(true);
  }

  function update(bump) {
    plan = computePlan();
    save();
    syncList();
    renderRoute();
    map.drawRoute();
    syncDock(bump);
    map.refreshPop();
    map.reframe();
  }

  function syncDock(bump) {
    var n = state.route.length, badge = $('dock-count');
    badge.hidden = !n;
    badge.textContent = String(n);
    $('dock').setAttribute('aria-label', n ? 'Open map and route, ' + n + ' pandals picked' : 'Open map and route');
    if (bump && n && !REDUCED.matches) {
      badge.classList.remove('bump');
      void badge.offsetWidth;
      badge.classList.add('bump');
    }
  }

  // ---------- route panel

  function renderRoute() {
    var has = !!plan;
    $('route-body').hidden = !has;
    $('route').classList.toggle('has', has);
    $('route-empty').hidden = has;
    $('clear-route').hidden = !has;
    $('route-title').textContent = has ? 'Your route, ' + plan.stops.length + (plan.stops.length === 1 ? ' pandal' : ' pandals') : 'Your route';

    var emptyText = $('route-empty-text');
    emptyText.textContent = lastCleared ? 'Route cleared.' : 'Tap + on any pandal, or add a whole area. The shortest order to visit them shows up here and on the map.';
    if (lastCleared) {
      var undo = el('button', 'link', 'Undo');
      undo.type = 'button';
      undo.addEventListener('click', function () { state.route = lastCleared; lastCleared = null; update(); });
      emptyText.appendChild(undo);
    }
    if (!has) return;

    document.querySelectorAll('[data-start]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.start === (plan.fromMe ? 'me' : 'best') ? 'true' : 'false');
    });
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
    });
    $('back').checked = state.back;

    var hours = plan.km / SPEED_KMH[state.mode];
    var count = plan.stops.length;
    if (count === 1 && !plan.fromMe) {
      $('summary').textContent = 'One pandal picked. Add more to plan a route between them.';
      $('quality').textContent = '';
    } else {
      $('summary').textContent = 'About ' + fmtKm(plan.km) + ' and ' + fmtTime(hours) +
        (state.mode === 'drive' ? ' of driving' : ' on foot') + ', plus your time at each pandal.';
      $('quality').textContent = plan.exact
        ? 'This is the shortest order for these stops.'
        : 'Near-shortest order. With ' + count + ' stops there are too many orders to check them all, so this one was improved until no change made it shorter.';
    }

    var ol = $('stops');
    ol.textContent = '';
    if (plan.fromMe) ol.appendChild(stopRow(null, 'you', 'Your location', 'Start here', null));
    plan.stops.forEach(function (p, i) {
      var sub = p.locality + (plan.legKm[i] && (i > 0 || plan.fromMe) ? ', ' + fmtKm(plan.legKm[i]) + ' from the last stop' : '');
      ol.appendChild(stopRow(p, String(i + 1), p.name, sub, p.note));
    });
    if (plan.closed) ol.appendChild(stopRow(null, 'home', 'Back to the start', fmtKm(plan.backKm), null));

    var legs = buildLegs(plan), box = $('legs');
    box.textContent = '';
    legs.forEach(function (leg) { box.appendChild(externalLink(leg.url, 'leg-btn', leg.text)); });
    $('legs-help').textContent = legs.length > 1
      ? 'Phones take a few stops per Google Maps link, so the route is split into ' + legs.length + ' legs. Open the next one when you finish a leg.'
      : '';
    $('legs-help').hidden = legs.length < 2;
  }

  function stopRow(p, mark, title, sub, note) {
    var li = el('li');
    var num = el('span', 'num' + (mark === 'you' ? ' you' : mark === 'home' ? ' home' : ''), mark === 'you' || mark === 'home' ? '' : mark);
    num.setAttribute('aria-hidden', 'true');
    var what = el('div', 'what');
    what.appendChild(el('strong', null, title));
    what.appendChild(el('span', null, sub));
    if (note) what.appendChild(el('span', 'note', note));
    li.appendChild(num);
    li.appendChild(what);
    if (p) {
      var rm = el('button', 'rm', '\u00d7');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + p.name + ' from route');
      rm.addEventListener('click', function () { toggleStop(p.id); });
      li.appendChild(rm);
    } else {
      li.appendChild(el('span'));
    }
    return li;
  }

  function setupRoutePanel() {
    $('route').addEventListener('click', function (e) {
      var b = e.target.closest('[data-start],[data-mode]');
      if (!b) return;
      if (b.dataset.mode) { state.mode = b.dataset.mode; update(); return; }
      if (b.dataset.start === 'best') { state.start = 'best'; geoMsg(''); update(); return; }
      useMyLocation();
    });
    $('back').addEventListener('change', function () { state.back = this.checked; update(); });
    $('clear-route').addEventListener('click', function () {
      lastCleared = state.route.slice();
      state.route = [];
      update();
    });
    withIcon($('share-route'), ICON.share, 'Share route');
    $('share-route').addEventListener('click', shareRoute);
  }

  function geoMsg(text) {
    var m = $('geo-msg');
    m.textContent = text;
    m.hidden = !text;
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      geoMsg('This browser cannot share your location. Start from the best first pandal instead.');
      return;
    }
    geoMsg('Finding your location\u2026');
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.me = [pos.coords.latitude, pos.coords.longitude];
      state.start = 'me';
      geoMsg('');
      map.showMe();
      update();
    }, function (err) {
      state.start = 'best';
      geoMsg(err && err.code === 1
        ? 'Location access is blocked. Allow it for this page in your browser settings, then tap My location again.'
        : 'Your location did not come through. Tap My location to try again, or start from the best first pandal.');
      update();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 120000 });
  }

  // ---------- sharing

  function pageUrl() { return location.href.split('#')[0]; }

  function share(title, text, url) {
    function whatsapp() {
      window.open('https://wa.me/?text=' + encodeURIComponent(text + '\n' + url), '_blank', 'noopener');
    }
    if (navigator.share) {
      navigator.share({ title: title, text: text, url: url }).catch(function (e) {
        if (!e || e.name !== 'AbortError') whatsapp();
      });
    } else {
      whatsapp();
    }
  }

  function sharePandal(p) {
    share(p.name, p.name + ', ' + p.locality + '. ' + data.meta.title + '.', p.maps_url);
  }

  function shareRoute() {
    if (!plan) return;
    var lines = plan.stops.map(function (p, i) { return (i + 1) + '. ' + p.name + ', ' + p.locality; });
    share('My pandal route', 'My pandal route for ' + data.meta.title + ':\n' + lines.join('\n'),
      pageUrl() + '#route=' + plan.stops.map(function (p) { return p.id; }).join(','));
  }

  // ---------- saving

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ route: state.route, back: state.back, mode: state.mode }));
    } catch (e) { /* storage off: picks last for this visit only */ }
  }

  function restore() {
    var hash = '';
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch (e) { hash = ''; }
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) {
        state.route = (saved.route || []).filter(function (id) { return byId[id]; });
        state.back = !!saved.back;
        state.mode = saved.mode === 'walk' ? 'walk' : 'drive';
      }
    } catch (e) { /* ignore unreadable storage */ }
    if (hash.indexOf('route=') === 0) {
      var ids = hash.slice(6).split(',').filter(function (id, i, all) { return byId[id] && all.indexOf(id) === i; });
      if (ids.length) {
        state.route = ids;
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ }
      }
    } else if (areaById[hash]) {
      state.area = hash;
    }
  }

  // ---------- mobile sheet

  function setupSheet() {
    var side = $('side');
    function open() {
      if (plan && plan.stops.length > 1) map.fitBest(false);
      side.classList.add('open');
      document.body.classList.add('sheet-open');
      $('close-sheet').focus();
    }
    function close() {
      side.classList.remove('open');
      document.body.classList.remove('sheet-open');
      map.closePop();
      $('dock').focus();
    }
    $('dock').addEventListener('click', open);
    $('close-sheet').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('pop').hidden) map.closePop();
      else if (side.classList.contains('open')) close();
    });
    if (DESKTOP.addEventListener) {
      DESKTOP.addEventListener('change', function () {
        if (DESKTOP.matches) { side.classList.remove('open'); document.body.classList.remove('sheet-open'); }
      });
    }
  }

  // ---------- map (plain SVG, no tiles, works offline)

  var map = (function () {
    var LAT0 = 18.55, LNG0 = 73.85;
    var KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KY = 110.57; // map units are kilometres
    var MIN_W = 1.6;
    var svgEl, gLand, gRoute, gLabels, gPins, meG;
    var vb = null, maxW = 80, pendingFit = null, home = null, fitArea_ = null, fitKey = null;
    var disp = {}, far = {}, pins = {}, labels = [], openId = null, hlId = null;

    function project(pos) { return [(pos[1] - LNG0) * KX, (LAT0 - pos[0]) * KY]; }

    function emptyBox() { return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; }
    function grow(b, xy) {
      b.x0 = Math.min(b.x0, xy[0]); b.y0 = Math.min(b.y0, xy[1]);
      b.x1 = Math.max(b.x1, xy[0]); b.y1 = Math.max(b.y1, xy[1]);
      return xy;
    }

    function init() {
      svgEl = $('map');
      gLand = sv('g', {}, svgEl);
      gRoute = sv('g', {}, svgEl);
      gLabels = sv('g', {}, svgEl);
      gPins = sv('g', {}, svgEl); // pins above labels: a stop number always wins over a place name

      var core = emptyBox();
      ((basemap && basemap.cities) || []).forEach(function (c) {
        c.rings.forEach(function (ring) {
          var d = ring.map(function (pt, i) {
            var xy = grow(core, project([pt[1], pt[0]]));
            return (i ? 'L' : 'M') + xy[0].toFixed(3) + ' ' + xy[1].toFixed(3);
          }).join('') + 'Z';
          sv('path', { d: d, 'class': 'city' }, gLand);
        });
      });

      // Pandals that share a locality centre sit on a small ring around it.
      var groups = {}, keys = [];
      data.pandals.forEach(function (p) {
        var key = p.pos.join(',');
        if (!groups[key]) { groups[key] = []; keys.push(key); }
        groups[key].push(p);
      });
      keys.forEach(function (key) {
        var members = groups[key], k = members.length, c = project(members[0].pos);
        var ring = k > 1 ? (k > 4 ? 0.42 : 0.3) : 0;
        members.forEach(function (p, i) {
          var a = -Math.PI / 2 + 2 * Math.PI * i / k;
          disp[p.id] = [c[0] + ring * Math.cos(a), c[1] + ring * Math.sin(a)];
        });
        members.center = c;
        members.ring = ring;
      });

      // Anything far outside the city (Lonavla) is drawn at the edge and labelled off the map.
      if (core.x0 === Infinity) data.pandals.forEach(function (p) { grow(core, disp[p.id]); });
      var edge = { x0: core.x0 - 1.5, y0: core.y0 - 1.5, x1: core.x1 + 1.5, y1: core.y1 + 1.5 };
      home = { x0: core.x0, y0: core.y0, x1: core.x1, y1: core.y1 };
      data.pandals.forEach(function (p) {
        var xy = disp[p.id];
        if (xy[0] < edge.x0 - 6 || xy[0] > edge.x1 + 6 || xy[1] < edge.y0 - 6 || xy[1] > edge.y1 + 6) {
          far[p.id] = true;
          disp[p.id] = [clamp(xy[0], edge.x0, edge.x1), clamp(xy[1], edge.y0, edge.y1)];
        }
        grow(home, disp[p.id]);
      });
      maxW = (home.x1 - home.x0) * 1.8;

      // Labels: areas when zoomed out, localities when zoomed in.
      data.areas.forEach(function (a) {
        var sx = 0, sy = 0, n = 0;
        data.pandals.forEach(function (p) {
          if (p.area === a.id && !far[p.id]) { sx += disp[p.id][0]; sy += disp[p.id][1]; n++; }
        });
        if (n) addLabel('area', a.name, sx / n, sy / n);
      });
      keys.forEach(function (key) {
        var g = groups[key], p = g[0];
        if (far[p.id]) addLabel('far', p.locality + ', off the map', disp[p.id][0], disp[p.id][1]);
        else addLabel('loc', p.locality, g.center[0], g.center[1] + g.ring);
      });

      labels.sort(function (x, y) { return (x.kind === 'far' ? 0 : 1) - (y.kind === 'far' ? 0 : 1); });

      data.pandals.forEach(function (p) {
        var g = sv('g', { 'class': 'pin', 'data-id': p.id, 'data-area': p.area }, gPins);
        sv('circle', { 'class': 'hit', r: 15 }, g);
        sv('circle', { 'class': 'ring', r: 15 }, g);
        sv('circle', { 'class': 'shade', r: 6.5, cx: 1.75, cy: 1.75 }, g); // hard offset shadow, signboard style
        sv('circle', { 'class': 'dot', r: 6.5 }, g);
        sv('text', { 'class': 'num', y: 0.5 }, g);
        pins[p.id] = g;
      });

      meG = sv('g', { 'class': 'me' }, svgEl);
      sv('circle', { 'class': 'halo', r: 16 }, meG);
      sv('circle', { 'class': 'dot', r: 7 }, meG);
      meG.style.display = 'none';

      bindGestures();
      $('zoom-in').addEventListener('click', function () { zoomBy(1.6); });
      $('zoom-out').addEventListener('click', function () { zoomBy(1 / 1.6); });
      $('zoom-fit').addEventListener('click', function () { fitBest(true); });

      if (window.ResizeObserver) new ResizeObserver(onResize).observe(svgEl);
      else window.addEventListener('resize', onResize);
      onResize();
    }

    // Candidate spots per label kind, in screen pixels: [dx, dy]; 'w' means half the label width plus a gap.
    var OFFSETS = {
      far: [[0, 0]],
      area: [[0, 0], [0, -22], [0, 22], ['-w', 0], ['w', 0], [0, -38], [0, 38]],
      loc: [[0, 22], [0, -20], ['w', 0], ['-w', 0], [0, 36]]
    };
    function addLabel(kind, text, x, y) {
      var g = sv('g', { 'class': 'lbl ' + kind }, gLabels);
      var t = sv('text', { x: kind === 'far' ? 14 : 0, y: 4 }, g);
      t.textContent = text;
      labels.push({ g: g, kind: kind, x: x, y: y, w: text.length * (kind === 'area' ? 7.4 : 6.6) + 6 });
    }

    function rect() { return svgEl.getBoundingClientRect(); }

    // On wide screens the route card floats on the map. These are the two parts of the map it
    // leaves clear, in screen pixels from the map's top-left: beside the card, and above it.
    function clearAreas(r) {
      var card = $('route');
      if (!card || getComputedStyle(card).position !== 'absolute') return [{ x: 0, w: r.width, h: r.height }];
      var c = card.getBoundingClientRect();
      return [
        { x: c.right - r.left + 16, w: r.right - c.right - 16, h: r.height },
        { x: 0, w: r.width, h: c.top - r.top - 16 }
      ].filter(function (a) { return a.w > 120 && a.h > 120; });
    }

    // The clear area where the box b shows largest (r is the map's screen rect).
    function bestArea(r, b) {
      var best = null;
      clearAreas(r).forEach(function (a) {
        a.s = Math.min(a.w / b.w, a.h / b.h); // pixels per kilometre
        if (!best || a.s > best.s) best = a;
      });
      return best || { x: 0, w: r.width, h: r.height, s: Math.min(r.width / b.w, r.height / b.h) };
    }

    function setView(v) {
      vb = v;
      render();
    }

    function render() {
      var r = rect();
      if (!vb || !r.width) return;
      svgEl.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
      var s = vb.w / r.width; // kilometres per screen pixel; pins and labels keep a fixed screen size
      Object.keys(pins).forEach(function (id) {
        pins[id].setAttribute('transform', 'translate(' + disp[id][0] + ' ' + disp[id][1] + ') scale(' + s + ')');
      });
      if (state.me) {
        var m = meXY();
        meG.setAttribute('transform', 'translate(' + m[0] + ' ' + m[1] + ') scale(' + s + ')');
      }
      // Greedy placement in screen space: try a few spots per label, prefer one clear of pins,
      // and drop the label if every spot overlaps a label already placed.
      var zoomedIn = vb.w < LOCALITY_ZOOM_KM, placed = [], pinBoxes = [];
      Object.keys(pins).forEach(function (id) {
        var on = plan && plan.index[id], r = on ? 12 : 8;
        var px = (disp[id][0] - vb.x) / s, py = (disp[id][1] - vb.y) / s;
        pinBoxes.push([px - r, py - r, px + r, py + r]);
      });
      function hits(box, list) {
        return list.some(function (b) { return box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]; });
      }
      labels.forEach(function (l) {
        var want = l.kind === 'far' || (zoomedIn ? l.kind === 'loc' : l.kind === 'area');
        var pick = null;
        if (want) {
          var sx = (l.x - vb.x) / s, sy = (l.y - vb.y) / s, fallback = null;
          OFFSETS[l.kind].some(function (o) {
            var dx = o[0] === 'w' ? l.w / 2 + 12 : o[0] === '-w' ? -(l.w / 2 + 12) : o[0], dy = o[1];
            var x = sx + dx, y = sy + dy;
            var box = l.kind === 'far' ? [x + 12, y - 8, x + 16 + l.w, y + 8] : [x - l.w / 2, y - 9, x + l.w / 2, y + 7];
            if (hits(box, placed)) return false;
            if (!fallback) fallback = { dx: dx, dy: dy, box: box };
            if (hits(box, pinBoxes)) return false;
            pick = { dx: dx, dy: dy, box: box };
            return true;
          });
          pick = pick || fallback;
        }
        l.g.style.display = pick ? '' : 'none';
        if (pick) {
          placed.push(pick.box);
          l.g.setAttribute('transform', 'translate(' + (l.x + pick.dx * s) + ' ' + (l.y + pick.dy * s) + ') scale(' + s + ')');
        }
      });
    }

    function onResize() {
      var r = rect();
      if (!r.width || !r.height) return;
      if (pendingFit || !vb) {
        var b = pendingFit || boxFor(state.area);
        pendingFit = null;
        fit(b, false);
        return;
      }
      var cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2, h = vb.w * r.height / r.width;
      setView({ x: cx - vb.w / 2, y: cy - h / 2, w: vb.w, h: h });
    }

    function boxFor(areaId) {
      if (areaId === 'all' || !areaById[areaId]) return home;
      var b = emptyBox();
      data.pandals.forEach(function (p) { if (p.area === areaId && !far[p.id]) grow(b, disp[p.id]); });
      return b.x0 === Infinity ? home : b;
    }

    function animateTo(target) {
      if (!vb || REDUCED.matches) return setView(target);
      var from = vb, t0 = performance.now();
      (function step(now) {
        var t = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - t, 3);
        setView({
          x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e,
          w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e
        });
        if (t < 1) requestAnimationFrame(step);
      })(t0);
    }

    function fit(b, animate) {
      var r = rect();
      if (!r.width || !r.height) { pendingFit = b; return; }
      var span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
      var pad = span * 0.06 + 0.9;
      // Fit into the part of the map the route card leaves clear, then extend the view under the card.
      var bw = b.x1 - b.x0 + 2 * pad, bh = b.y1 - b.y0 + 2 * pad;
      var a = bestArea(r, { w: bw, h: bh });
      fitArea_ = a;
      fitKey = cardKey();
      var u = Math.max(1 / a.s, 4 / a.w), w = u * r.width, h = u * r.height;
      var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      var target = { x: cx - (a.x + a.w / 2) * u, y: cy - (a.h / 2) * u, w: w, h: h };
      if (w > maxW) maxW = w * 1.25;
      if (animate) animateTo(target); else setView(target);
    }

    function fitArea(areaId, animate) { fit(boxFor(areaId), animate); }

    // Which shape the route card has on the map: 'flow' when it is not on the map at all
    // (phones, mid widths), otherwise the short hint or the full route.
    function cardKey() {
      var card = $('route');
      if (!card || getComputedStyle(card).position !== 'absolute') return 'flow';
      return card.classList.contains('has') ? 'route' : 'hint';
    }

    // When the route card switches between the hint and the full route (wide layout only), move the
    // current view (all pandals or the chosen area) into the part of the map the card leaves clear.
    function reframe() {
      if (vb && fitKey && cardKey() !== fitKey) fitArea(state.area, true);
    }

    // The route if there is one, otherwise the current area.
    function fitBest(animate) {
      if (!plan || plan.stops.length < 2) return fitArea(state.area, animate);
      var b = emptyBox();
      plan.stops.forEach(function (p) { grow(b, disp[p.id]); });
      if (plan.fromMe) grow(b, meXY());
      fit(b, animate);
    }

    // Zoom keeping the map point under (px, py) fixed on screen.
    function zoomAt(factor, px, py) {
      var r = rect(), v = vb;
      var u = v.w / r.width;
      var mx = v.x + (px - r.left) * u, my = v.y + (py - r.top) * u;
      var w = clamp(v.w / factor, MIN_W, maxW), k = w / v.w;
      setView({ x: mx - (mx - v.x) * k, y: my - (my - v.y) * k, w: w, h: v.h * k });
    }

    function zoomBy(factor) {
      var r = rect(), a = fitArea_ && clearAreas(r).length > 1 ? fitArea_ : { x: 0, w: r.width, h: r.height };
      zoomAt(factor, r.left + a.x + a.w / 2, r.top + a.h / 2);
    }

    function bindGestures() {
      var pointers = {}, drag = null, pinch = null, moved = false;
      function pts() { return Object.keys(pointers).map(function (k) { return pointers[k]; }); }
      function pinchState() {
        var p = pts();
        return { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2 };
      }

      svgEl.addEventListener('pointerdown', function (e) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var n = pts().length;
        if (n === 1) { drag = { x: e.clientX, y: e.clientY, vb: vb }; moved = false; }
        if (n === 2) { pinch = pinchState(); pinch.vb = vb; drag = null; moved = true; }
      });
      svgEl.addEventListener('pointermove', function (e) {
        if (!pointers[e.pointerId]) return;
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        if (pinch && pts().length === 2) {
          var cur = pinchState(), r = rect(), v = pinch.vb;
          var u0 = v.w / r.width;
          var mx = v.x + (pinch.cx - r.left) * u0, my = v.y + (pinch.cy - r.top) * u0;
          var w = clamp(v.w * pinch.d / cur.d, MIN_W, maxW), u1 = w / r.width;
          setView({ x: mx - (cur.cx - r.left) * u1, y: my - (cur.cy - r.top) * u1, w: w, h: w * r.height / r.width });
          return;
        }
        if (!drag) return;
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        if (!moved) {
          moved = true;
          try { svgEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          svgEl.classList.add('dragging');
        }
        var uu = drag.vb.w / rect().width;
        setView({ x: drag.vb.x - dx * uu, y: drag.vb.y - dy * uu, w: drag.vb.w, h: drag.vb.h });
      });
      function end(e) {
        delete pointers[e.pointerId];
        var left = pts();
        if (left.length < 2) pinch = null;
        if (left.length === 1) drag = { x: left[0].x, y: left[0].y, vb: vb };
        if (!left.length) { drag = null; svgEl.classList.remove('dragging'); }
      }
      svgEl.addEventListener('pointerup', end);
      svgEl.addEventListener('pointercancel', end);
      svgEl.addEventListener('click', function (e) {
        if (moved) { moved = false; return; }
        var pin = e.target.closest && e.target.closest('.pin');
        if (pin) {
          openPop(pin.getAttribute('data-id'));
          flashCard(pin.getAttribute('data-id')); // on desktop, point at its card in the list
        } else {
          closePop();
        }
      });
      svgEl.addEventListener('wheel', function (e) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX, e.clientY);
      }, { passive: false });
    }

    function meXY() {
      var xy = project(state.me);
      return [clamp(xy[0], home.x0 - 3, home.x1 + 3), clamp(xy[1], home.y0 - 3, home.y1 + 3)];
    }

    function showMe() {
      meG.style.display = state.me ? '' : 'none';
      render();
    }

    function drawRoute() {
      gRoute.textContent = '';
      Object.keys(pins).forEach(function (id) {
        var g = pins[id], n = plan ? plan.index[id] || 0 : 0;
        g.classList.toggle('on', !!n);
        g.querySelector('.dot').setAttribute('r', n ? 10.5 : 6.5);
        g.querySelector('.shade').setAttribute('r', n ? 10.5 : 6.5);
        g.querySelector('.num').textContent = n ? String(n) : '';
        if (n) gPins.appendChild(g); // numbered pins on top
      });
      dim();
      render();
      $('zoom-fit').setAttribute('aria-label', plan && plan.stops.length > 1 ? 'Show the whole route' : 'Show all pins in view');
      if (!plan) return;
      var seq = plan.stops.map(function (p) { return { xy: disp[p.id], far: !!far[p.id] }; });
      if (plan.fromMe) seq.unshift({ xy: meXY(), far: false });
      if (plan.closed) seq.push(seq[0]);
      for (var i = 1; i < seq.length; i++) {
        sv('line', {
          'class': 'leg-line' + (seq[i - 1].far || seq[i].far ? ' far' : ''),
          x1: seq[i - 1].xy[0], y1: seq[i - 1].xy[1], x2: seq[i].xy[0], y2: seq[i].xy[1]
        }, gRoute);
      }
    }

    var hiddenFn = function () { return false; };
    function dim(hidden) {
      if (hidden) hiddenFn = hidden;
      Object.keys(pins).forEach(function (id) {
        pins[id].classList.toggle('dim', hiddenFn(id) && !(plan && plan.index[id]));
      });
    }

    function highlight(id) {
      if (hlId && pins[hlId]) pins[hlId].classList.remove('hl');
      hlId = id;
      if (id && pins[id]) pins[id].classList.add('hl');
    }

    function openPop(id) {
      var p = byId[id];
      if (!p) return;
      openId = id;
      highlight(id);
      var pop = $('pop');
      pop.textContent = '';
      var x = el('button', 'pop-x', '\u00d7');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', closePop);
      pop.appendChild(x);
      pop.dataset.area = p.area;
      pop.appendChild(el('p', 'pop-area', areaById[p.area].name));
      pop.appendChild(el('h3', null, p.name));
      pop.appendChild(el('p', 'loc', p.locality + (far[id] ? ', off the map' : '')));
      if (p.note) pop.appendChild(el('p', 'note', p.note));
      var acts = el('div', 'acts'), n = plan ? plan.index[id] || 0 : 0;
      var t = el('button', 'act' + (n ? '' : ' primary'), n ? 'Remove stop ' + n : '+ Add to route');
      t.type = 'button';
      t.addEventListener('click', function () { toggleStop(id); });
      acts.appendChild(t);
      acts.appendChild(withIcon(externalLink(p.maps_url, 'act maps'), ICON.pin, 'Maps'));
      pop.appendChild(acts);
      pop.hidden = false;
    }

    function flashCard(id) {
      var card = cardEls[id];
      if (!DESKTOP.matches || !card || card.hidden) return;
      var r = card.getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight) card.scrollIntoView({ block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }

    function refreshPop() { if (openId && !$('pop').hidden) openPop(openId); }

    function closePop() {
      openId = null;
      highlight(null);
      $('pop').hidden = true;
    }

    // From a card: centre its pin and show its details.
    function focus(id) {
      if (!vb) return;
      var xy = disp[id], w = Math.min(vb.w, 9), r = rect(), h = w * r.height / r.width;
      animateTo({ x: xy[0] - w / 2, y: xy[1] - h / 2, w: w, h: h });
      openPop(id);
    }

    return {
      init: init, fitArea: fitArea, fitBest: fitBest, reframe: reframe, drawRoute: drawRoute, dim: dim, showMe: showMe,
      focus: focus, closePop: closePop, refreshPop: refreshPop
    };
  })();

  // ---------- start

  function getJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function load() {
    if (window.PUJO_DATA) return Promise.resolve(window.PUJO_DATA);
    return Promise.all([
      getJSON('data/pandals.json'),
      getJSON('data/basemap.json').catch(function () { return { cities: [] }; })
    ]).then(function (r) { return { pandals: r[0], basemap: r[1] }; });
  }

  load()
    .then(function (bundle) {
      data = bundle.pandals;
      basemap = bundle.basemap;
      data.pandals.forEach(function (p) { byId[p.id] = p; });
      data.areas.forEach(function (a) { areaById[a.id] = a; });

      $('lede').textContent = 'All ' + data.pandals.length + ' Bengali Durga Puja pandals in Pune and PCMC, across ' +
        data.areas.length + ' areas. Pick the ones you want to see and get the shortest order to visit them.';
      if (data.meta.full_map_url) $('full-map').href = data.meta.full_map_url;

      restore();
      renderChips();
      renderList();
      renderContacts(data.meta);
      map.init();
      setupRoutePanel();
      setupSheet();

      $('q').addEventListener('input', function () { state.q = this.value; applyFilter(); });
      setArea(state.area, false);
      update(false);
    })
    .catch(function (err) {
      if (window.console) console.error(err);
      $('areas').textContent = 'The pandal list did not load. Check your connection and refresh the page.';
    });
})();
