(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY = 86400000;
  var SEV_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fmtDate(iso) { if (!iso) return '—'; var p = iso.split('-'); return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function fmtShort(iso) { var p = iso.split('-'); return (+p[2]) + ' ' + MONTHS[+p[1] - 1]; }
  function fmtMonth(iso) { var p = iso.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0].slice(2); }
  function n(x) { return Math.round(x).toLocaleString('en-US'); }
  function usd(x) {
    var a = Math.abs(x);
    if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + Math.round(x / 1e3) + 'K';
    return '$' + Math.round(x);
  }
  function svg(tag, attrs, parent) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(el);
    return el;
  }
  function store(key, value) {
    try { if (value === undefined) return window.localStorage.getItem(key); window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
    return null;
  }

  var app = angular.module('labApp', []);
  app.config(['$locationProvider', function ($lp) { $lp.hashPrefix(''); }]);

  /* ------------------------------------------------------------------ chart directive
   * Draws the pool forecast as SVG. Series: utilized history, forecast (middle),
   * planning margin (p50 to p80), usable capacity, working ceiling, ceiling once the
   * drafted order lands. Marks are 2px lines; the wash is 10% opacity; markers carry
   * a shape as well as a colour. A crosshair snaps to the nearest week and one
   * tooltip lists every series. Everything the tooltip shows is also in the table view.
   */
  app.directive('capChart', function () {
    return {
      restrict: 'E',
      scope: { chart: '=' },
      link: function (scope, element) {
        var host = element[0];
        scope.$watch('chart', function (c) { render(host, c); });
      },
    };
  });

  function niceStep(max) {
    if (!max || max <= 0 || isNaN(max)) return 250;
    var raw = max / 4;
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  function render(host, c) {
    host.innerHTML = '';
    if (!c) return;
    var W = 760; var H = 380; var m = { l: 56, r: 20, t: 64, b: 30 };
    var pw = W - m.l - m.r; var ph = H - m.t - m.b;
    var X0 = -26; var X1 = c.horizon_weeks;
    var hist = c.history; var nH = hist.length;
    var asOf = hist[nH - 1].date;
    var histAt = function (w) { var i = nH - 1 + w; return i >= 0 && i < nH ? hist[i].value : null; };

    var ymax = 0;
    for (var w = X0; w <= 0; w++) ymax = Math.max(ymax, histAt(w) || 0);
    ['upper', 'usable', 'ceiling', 'ceiling_with_order'].forEach(function (k) {
      if (c[k]) c[k].forEach(function (p) { ymax = Math.max(ymax, p.value); });
    });
    var step = niceStep(ymax * 1.05);
    var top = Math.ceil(ymax * 1.05 / step) * step;
    var sx = function (x) { return m.l + (x - X0) / (X1 - X0) * pw; };
    var sy = function (v) { return m.t + ph - v / top * ph; };

    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: '0',
      'aria-label': 'Utilization history and forecast against capacity and the working ceiling. Use the arrow keys to read values week by week.' }, host);

    // grid and axes
    var gy = svg('g', { 'class': 'axis' }, root);
    for (var v = 0; v <= top + 1; v += step) {
      svg('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), 'class': 'grid' }, gy);
      var t = svg('text', { x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end' }, gy); t.textContent = n(v);
    }
    for (var xw = -26; xw <= X1; xw += 13) {
      var date = new Date(utc(asOf) + xw * 7 * DAY).toISOString().slice(0, 10);
      var tx = svg('text', { x: sx(xw), y: H - 8, 'text-anchor': 'middle' }, gy); tx.textContent = fmtMonth(date);
    }
    var unit = svg('text', { x: m.l - 8, y: m.t - 12, 'text-anchor': 'end' }, gy); unit.textContent = 'CU';

    // planning margin (p50 to p80)
    var band = 'M' + sx(0) + ' ' + sy(c.p50[0].value);
    for (var i = 1; i <= X1; i++) band += ' L' + sx(i) + ' ' + sy(c.upper[i].value);
    for (var j = X1; j >= 0; j--) band += ' L' + sx(j) + ' ' + sy(c.p50[j].value);
    svg('path', { d: band + ' Z', 'class': 'a-band' }, root);

    function stepPath(arr) {
      var d = 'M' + sx(0) + ' ' + sy(arr[0].value); var prev = arr[0].value;
      for (var k = 1; k <= X1; k++) {
        if (arr[k].value !== prev) { d += ' H' + sx(k) + ' V' + sy(arr[k].value); prev = arr[k].value; }
      }
      return d + ' H' + sx(X1);
    }
    function linePath(arr, from) {
      var d = '';
      for (var k = from; k <= X1; k++) d += (d ? ' L' : 'M') + sx(k) + ' ' + sy(arr[k].value);
      return d;
    }
    svg('path', { d: stepPath(c.usable), 'class': 'l-usable' }, root);
    svg('path', { d: stepPath(c.ceiling), 'class': 'l-ceiling' }, root);
    if (c.ceiling_with_order) svg('path', { d: stepPath(c.ceiling_with_order), 'class': 'l-ceiling2' }, root);
    svg('path', { d: linePath(c.upper, 0), 'class': 'l-p80' }, root);
    var hp = '';
    for (var hw = X0; hw <= 0; hw++) hp += (hp ? ' L' : 'M') + sx(hw) + ' ' + sy(histAt(hw));
    svg('path', { d: hp, 'class': 'l-hist' }, root);
    svg('path', { d: linePath(c.p50, 0), 'class': 'l-fc' }, root);
    svg('line', { x1: sx(0), x2: sx(0), y1: m.t, y2: m.t + ph, 'class': 'today' }, root);
    var todayLbl = svg('text', { x: sx(0) + 4, y: m.t + ph - 6, 'class': 'mk-label' }, root); todayLbl.textContent = 'Today';

    // direct labels for the two threshold lines, only when they do not collide
    var lastCeil = c.ceiling[X1].value; var lastUse = c.usable[X1].value;
    function endLabel(text, val, dy) {
      var l = svg('text', { x: W - m.r - 2, y: sy(val) + dy, 'text-anchor': 'end', 'class': 'mk-label' }, root); l.textContent = text;
    }
    endLabel('Working ceiling', lastCeil, 16);
    if (Math.abs(sy(lastUse) - sy(lastCeil)) > 24) endLabel('Capacity', lastUse, -7);

    // event markers: a line and a shape for each. Only the three key ones (needed, order by,
    // lands) get a text label, each on its own row so they never collide; every marker is
    // listed in words under the chart, so nothing depends on reading tiny labels.
    var shapes = { needed: 'diamond', raise: 'tri', lands: 'dot', deadline: 'sq', contract: 'sq', event: 'sq' };
    var rowOf = { needed: 0, raise: 1, lands: 2 };
    var sorted = (c.markers || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    sorted.forEach(function (mk) {
      var wk = Math.round((utc(mk.date) - utc(asOf)) / (7 * DAY));
      if (wk < X0 || wk > X1) return;
      var x = sx(wk);
      var keyed = rowOf[mk.kind] !== undefined;
      var y = keyed ? 12 + rowOf[mk.kind] * 16 : m.t - 8;
      svg('line', { x1: x, x2: x, y1: y, y2: m.t + ph, 'class': 'mk-line mk-' + mk.kind }, root);
      var g = svg('g', { 'class': 'mk-' + mk.kind }, root);
      var s = shapes[mk.kind];
      if (s === 'diamond') svg('path', { d: 'M' + x + ' ' + (y - 6) + ' l6 6 l-6 6 l-6 -6 z', 'class': 'mk-shape' }, g);
      else if (s === 'tri') svg('path', { d: 'M' + x + ' ' + (y - 6) + ' l6 11 h-12 z', 'class': 'mk-shape' }, g);
      else if (s === 'dot') svg('circle', { cx: x, cy: y, r: 5, 'class': 'mk-shape' }, g);
      else svg('rect', { x: x - 5, y: y - 5, width: 10, height: 10, 'class': 'mk-shape' }, g);
      var tt = svg('title', null, g); tt.textContent = mk.label + ' · ' + fmtDate(mk.actual || mk.date);
      if (keyed) {
        var anchor = x > W - 190 ? 'end' : 'start';
        var lt = svg('text', { x: anchor === 'end' ? x - 10 : x + 10, y: y + 4, 'text-anchor': anchor, 'class': 'mk-label' }, root);
        lt.textContent = mk.label + ' · ' + fmtShort(mk.actual || mk.date);
      }
    });

    // hover layer
    var cross = svg('line', { y1: m.t, y2: m.t + ph, 'class': 'cross', visibility: 'hidden' }, root);
    var dots = {};
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.display = 'none'; host.appendChild(tip);
    var hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, 'class': 'hit' }, root);
    var cur = 0;

    function rows(wk) {
      var r = []; var e;
      if (wk <= 0) { var hv = histAt(wk); if (hv !== null) r.push(['Utilized', hv, 'var(--colorSeries1)', false]); }
      if (wk >= 0) {
        r.push([wk === 0 ? 'Latest reading' : 'Forecast (middle)', c.p50[wk].value, 'var(--colorSeries1)', wk !== 0]);
        if (wk > 0) r.push(['Planning level (p80)', c.upper[wk].value, 'var(--colorSeries1)', false]);
        r.push(['Capacity', c.usable[wk].value, 'var(--colorNeutralForeground3)', false]);
        r.push(['Working ceiling', c.ceiling[wk].value, 'var(--colorSeries2)', false]);
        if (c.ceiling_with_order) r.push(['Ceiling with drafted order', c.ceiling_with_order[wk].value, 'var(--colorSeries3)', true]);
      }
      return r;
    }
    function show(wk) {
      cur = wk;
      var x = sx(wk);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      var date = new Date(utc(asOf) + wk * 7 * DAY).toISOString().slice(0, 10);
      tip.innerHTML = '';
      var head = document.createElement('div'); head.className = 'chart-tip__date';
      head.textContent = fmtDate(date) + (wk === 0 ? ' (today)' : wk < 0 ? '' : ' · week +' + wk); tip.appendChild(head);
      Object.keys(dots).forEach(function (k) { dots[k].parentNode && dots[k].parentNode.removeChild(dots[k]); delete dots[k]; });
      rows(wk).forEach(function (r) {
        var row = document.createElement('div'); row.className = 'chart-tip__row';
        var key = document.createElement('span'); key.className = 'key' + (r[3] ? ' key--dash' : ''); key.style.borderTopColor = r[2];
        var name = document.createElement('span'); name.textContent = r[0];
        var val = document.createElement('b'); val.textContent = n(r[1]);
        row.appendChild(key); row.appendChild(name); row.appendChild(val); tip.appendChild(row);
      });
      var first = rows(wk)[0];
      if (first) { var d = svg('circle', { cx: x, cy: sy(first[1]), r: 4, fill: first[2], 'class': 'dot' }, root); dots.a = d; }
      var rect = host.getBoundingClientRect();
      var scale = rect.width / W;
      tip.style.display = 'block';
      var px = x * scale; var tw = tip.offsetWidth;
      tip.style.left = Math.max(4, Math.min(rect.width - tw - 4, px + 14)) + 'px';
      tip.style.top = Math.max(0, (m.t + 10) * scale) + 'px';
    }
    function fromEvent(ev) {
      var r = root.getBoundingClientRect();
      var x = (ev.clientX - r.left) / r.width * W;
      return Math.max(X0, Math.min(X1, Math.round(X0 + (x - m.l) / pw * (X1 - X0))));
    }
    hit.addEventListener('pointermove', function (ev) { show(fromEvent(ev)); });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; Object.keys(dots).forEach(function (k) { dots[k].parentNode && dots[k].parentNode.removeChild(dots[k]); delete dots[k]; }); });
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { show(Math.min(X1, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { show(Math.max(X0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    });
    root.addEventListener('focus', function () { show(cur); });
  }

  /* ------------------------------------------------------------------ overview forecast chart
   * Demand vs capacity by month for every pool in scope: forecast demand (line), provisioned
   * capacity (dashed), effective capacity at the working ceiling (dotted) and the shortfall
   * (bars, from zero, rounded at the top). The peak shortfall is called out. A crosshair and
   * one tooltip list all four series; the same values are in the table view under the chart.
   */
  app.directive('capOverviewChart', function () {
    return {
      restrict: 'E',
      scope: { data: '=' },
      link: function (scope, element) {
        var host = element[0]; var lastW = 0;
        var draw = function () { lastW = host.clientWidth; renderOverview(host, scope.data); };
        scope.$watch('data', draw);
        // Redraw when the card changes width, so the chart is drawn 1:1 and its text keeps its size.
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { if (Math.abs(host.clientWidth - lastW) > 8) draw(); });
          ro.observe(host);
          scope.$on('$destroy', function () { ro.disconnect(); });
        }
      },
    };
  });

  /* ------------------------------------------------------------------ team forecast chart
   * The Product Team view: one request's demand, the team's own usage, and the capacity it can count on.
   * Demand and usage are smooth curves; capacity is a true step line, because it changes on the days supply lands, not
   * gradually. The need date is called out. Drawn from the weekly series so each step falls in the right week; the
   * monthly table under the chart has the same values.
   */
  app.directive('capTeamChart', function () {
    return {
      restrict: 'E',
      scope: { data: '=' },
      link: function (scope, element) {
        var host = element[0]; var lastW = 0;
        var draw = function () { lastW = host.clientWidth; renderTeam(host, scope.data); };
        scope.$watch('data', draw);
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { if (Math.abs(host.clientWidth - lastW) > 8) draw(); });
          ro.observe(host);
          scope.$on('$destroy', function () { ro.disconnect(); });
        }
      },
    };
  });

  // A smooth curve through the points that never overshoots them (monotone cubic, Fritsch-Carlson): a line
  // that levels off stays level, and a curve never dips below a value that only rose. Points are {x, y}.
  function smoothPath(p) {
    var n = p.length; var r = function (v) { return Math.round(v * 10) / 10; };
    if (n < 3) return p.map(function (q, i) { return (i ? 'L' : 'M') + r(q.x) + ' ' + r(q.y); }).join(' ');
    var dx = []; var d = []; var m = []; var i;
    for (i = 0; i < n - 1; i++) { dx[i] = p[i + 1].x - p[i].x; d[i] = (p[i + 1].y - p[i].y) / dx[i]; }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / d[i]; var b = m[i + 1] / d[i]; var s = a * a + b * b;
      if (s > 9) { var t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    var out = 'M' + r(p[0].x) + ' ' + r(p[0].y);
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      out += ' C' + r(p[i].x + h) + ' ' + r(p[i].y + m[i] * h) + ' ' + r(p[i + 1].x - h) + ' ' + r(p[i + 1].y - m[i + 1] * h) + ' ' + r(p[i + 1].x) + ' ' + r(p[i + 1].y);
    }
    return out;
  }

  function renderOverview(host, f) {
    host.innerHTML = '';
    if (!f || !f.points.length) return;
    // Room above the plot for the peak call-out only when there is one to show.
    var W = Math.max(260, Math.round(host.clientWidth || 620)); var H = f.peak_shortfall ? 330 : 286; var m = { l: 46, r: 14, t: f.peak_shortfall ? 62 : 18, b: 28 };
    var pw = W - m.l - m.r; var ph = H - m.t - m.b;
    var pts = f.points; var last = pts.length - 1;
    var ymax = 0;
    pts.forEach(function (p) { ymax = Math.max(ymax, p.demand, p.provisioned, p.effective); });
    var plotMax = Math.max(ymax, 1000);
    var step = niceStep(plotMax * 1.05);
    var top = Math.max(step, Math.ceil(plotMax * 1.05 / step) * step);
    var sx = function (i) { return m.l + (last ? i / last : 0.5) * pw; };
    var sy = function (v) { return m.t + ph - (top > 0 ? (v / top * ph) : 0); };
    var kfmt = function (v) { return v >= 1000 ? (v / 1000) + 'K' : String(v); };

    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: '0',
      'aria-label': 'Forecast demand against provisioned and effective capacity by month, with the shortfall as bars. Use the arrow keys to read each month.' }, host);
    var ax = svg('g', { 'class': 'axis' }, root);
    for (var v = 0; v <= top + 1; v += step) {
      svg('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), 'class': 'grid' }, ax);
      var yl = svg('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end' }, ax); yl.textContent = kfmt(v);
    }
    var peakMonth = f.peak_shortfall ? f.peak_shortfall.month : -1;
    pts.forEach(function (p, i) {
      var xl = svg('text', { x: sx(i), y: H - 8, 'text-anchor': 'middle' }, ax); xl.textContent = MONTHS[+p.date.split('-')[1] - 1];
      if (i === peakMonth) xl.setAttribute('class', 'peak');                      // the peak month is marked on the axis, too
    });

    // shortfall bars: from the baseline, capped width, 4px rounded top, a gap between neighbours. The bigger the
    // shortfall, the stronger the colour, so the eye lands on the worst months as well as the tallest bars.
    var bw = Math.min(22, (last ? pw / last : pw) * 0.55);
    var maxShort = 0; pts.forEach(function (p) { maxShort = Math.max(maxShort, p.shortfall); });
    pts.forEach(function (p, i) {
      if (p.shortfall <= 0) return;
      var x = sx(i) - bw / 2; var y = sy(p.shortfall); var h = sy(0) - y; var r = Math.min(4, h / 2, bw / 2);
      var bar = svg('path', { d: 'M' + x + ' ' + (y + h) + ' V' + (y + r) + ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + ' H' + (x + bw - r) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + r) + ' V' + (y + h) + ' Z', 'class': 'ob-bar' }, root);
      bar.style.opacity = (0.42 + 0.58 * (p.shortfall / maxShort)).toFixed(2);
    });
    function line(key, cls) {
      return svg('path', { d: smoothPath(pts.map(function (p, i) { return { x: sx(i), y: sy(p[key]) }; })), 'class': cls }, root);
    }
    line('effective', 'ol-eff'); line('provisioned', 'ol-prov'); line('demand', 'ol-dem');

    // the peak shortfall, called out: a dotted line from the month up to a two-line label
    if (f.peak_shortfall) {
      var px = sx(peakMonth); var cw = 168; var ch = 44;
      svg('line', { x1: px, x2: px, y1: 2 + ch, y2: sy(0), 'class': 'ob-peak' }, root);
      var bx = Math.max(m.l, Math.min(W - m.r - cw, px - cw / 2));
      svg('rect', { x: bx, y: 2, width: cw, height: ch, rx: 8, 'class': 'ob-callout' }, root);
      var ct = svg('g', { 'class': 'ob-calltext' }, root);
      var head = svg('text', { x: bx + cw / 2, y: 20, 'text-anchor': 'middle', 'class': 'ob-callhead' }, ct); head.textContent = 'Projected shortfall ';
      var body = svg('text', { x: bx + cw / 2, y: 37, 'text-anchor': 'middle' }, ct);
      var num = svg('tspan', { 'class': 'ob-callnum' }, body); num.textContent = n(f.peak_shortfall.cu) + ' CU';
      var when = svg('tspan', {}, body); when.textContent = ' (' + MONTHS[+f.peak_shortfall.date.split('-')[1] - 1] + ' ' + f.peak_shortfall.date.slice(0, 4) + ')';
    }

    // hover layer
    var cross = svg('line', { y1: m.t, y2: sy(0), 'class': 'cross', visibility: 'hidden' }, root);
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.display = 'none'; host.appendChild(tip);
    var hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, 'class': 'hit' }, root);
    var cur = 0;
    function show(i) {
      cur = i; var p = pts[i]; var x = sx(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = '';
      var head = document.createElement('div'); head.className = 'chart-tip__date'; head.textContent = fmtDate(p.date); tip.appendChild(head);
      [['Forecast demand', p.demand, 'key--dem'], ['Provisioned capacity', p.provisioned, 'key--prov'],
        ['Effective capacity', p.effective, 'key--eff'], ['Shortfall', p.shortfall, 'key--bar']].forEach(function (r) {
        var row = document.createElement('div'); row.className = 'chart-tip__row';
        var key = document.createElement('span'); key.className = 'key ' + r[2];
        var name = document.createElement('span'); name.textContent = r[0];
        var val = document.createElement('b'); val.textContent = n(r[1]);
        row.appendChild(key); row.appendChild(name); row.appendChild(val); tip.appendChild(row);
      });
      var rect = host.getBoundingClientRect(); var scale = rect.width / W;
      tip.style.display = 'block';
      var tw = tip.offsetWidth; var left = x * scale + 12;
      if (left + tw > rect.width - 4) left = x * scale - tw - 12;
      tip.style.left = Math.max(4, left) + 'px'; tip.style.top = (m.t + 8) * scale + 'px';
    }
    function fromEvent(ev) {
      var r = root.getBoundingClientRect(); var x = (ev.clientX - r.left) / r.width * W;
      return Math.max(0, Math.min(last, Math.round(((x - m.l) / pw) * last)));
    }
    hit.addEventListener('pointermove', function (ev) { show(fromEvent(ev)); });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { show(Math.min(last, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { show(Math.max(0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    });
    root.addEventListener('focus', function () { show(cur); });
  }

  function smoothPath(pts) {
    if (!pts || !pts.length) return '';
    if (pts.length === 1) return 'M ' + pts[0].x + ' ' + pts[0].y;
    var d = 'M ' + pts[0].x + ' ' + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = i > 0 ? pts[i - 1] : pts[0];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = (i < pts.length - 2) ? pts[i + 2] : p2;
      var cp1x = p1.x + (p2.x - p0.x) / 6;
      var cp1y = p1.y + (p2.y - p0.y) / 6;
      var cp2x = p2.x - (p3.x - p1.x) / 6;
      var cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C ' + cp1x + ' ' + cp1y + ', ' + cp2x + ' ' + cp2y + ', ' + p2.x + ' ' + p2.y;
    }
    return d;
  }

  function renderTeam(host, f) {
    host.innerHTML = '';
    if (!f) return;
    var pts = (f.points && f.points.length >= 4) ? f.points : (f.weekly || []);
    if (!pts.length) return;
    var last = pts.length - 1;
    var co = f.callout;
    var W = Math.max(260, Math.round(host.clientWidth || 580));
    var H = 280;
    var m = { l: 48, r: 20, t: 40, b: 32 };
    var pw = W - m.l - m.r;
    var ph = H - m.t - m.b;

    var ymax = 0;
    pts.forEach(function (p) { ymax = Math.max(ymax, p.demand || 0, p.usage || 0, p.capacity || 0, p.requested || 0); });
    if (ymax < 10000) ymax = 12000;
    var step = 2000;
    var top = Math.ceil(ymax / step) * step;
    if (top < 12000) top = 12000;

    var sx = function (i) { return m.l + (last ? (i / last) * pw : 0.5 * pw); };
    var sy = function (v) { return m.t + ph - Math.min(ph, (v / top) * ph); };
    var kfmt = function (v) { return v === 0 ? '0' : (v / 1000) + 'K'; };

    var root = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      role: 'img',
      tabindex: '0',
      'aria-label': 'Forecast demand against current usage and requested capacity. Use the arrow keys to read each month.'
    }, host);

    var ax = svg('g', { 'class': 'axis' }, root);

    // Y Axis Caption: "Capacity Units (CU)" rotated or top left
    var yCaption = svg('text', { x: 12, y: m.t - 14, 'class': 'axis-caption', 'style': 'font-size: 11px; fill: #605e5c; font-weight: 500;' }, ax);
    yCaption.textContent = 'Capacity Units (CU)';

    // Horizontal Grid Lines & Y-axis labels
    for (var v = 0; v <= top; v += step) {
      svg('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), 'class': 'grid', 'stroke': '#edebe9', 'stroke-width': '1' }, ax);
      var yl = svg('text', { x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end', 'style': 'font-size: 11px; fill: #8a8886;' }, ax);
      yl.textContent = kfmt(v);
    }

    // X Axis Month Labels
    pts.forEach(function (p, i) {
      var xl = svg('text', { x: sx(i), y: H - 10, 'text-anchor': 'middle', 'style': 'font-size: 11px; fill: #605e5c;' }, ax);
      xl.textContent = p.month_label || (p.date ? MONTHS[+p.date.split('-')[1] - 1] : MONTHS[i % 12]);
    });

    // 1. Red Dashed Line: Requested Capacity (horizontal threshold)
    var reqVal = (pts[0] && pts[0].requested) ? pts[0].requested : 6000;
    var reqY = sy(reqVal);
    svg('line', {
      x1: m.l, x2: W - m.r, y1: reqY, y2: reqY,
      'stroke': '#d13438', 'stroke-width': '1.5', 'stroke-dasharray': '4 4'
    }, root);

    // 2. Purple Line: Current Usage
    var usePath = smoothPath(pts.map(function (p, i) { return { x: sx(i), y: sy(p.usage || 0) }; }));
    svg('path', { d: usePath, 'fill': 'none', 'stroke': '#8764b8', 'stroke-width': '2.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, root);

    // 3. Blue Line: Forecast Demand
    var demPath = smoothPath(pts.map(function (p, i) { return { x: sx(i), y: sy(p.demand || 0) }; }));
    svg('path', { d: demPath, 'fill': 'none', 'stroke': '#0078d4', 'stroke-width': '2.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, root);

    // 4. Circular Markers on Forecast Demand Line
    pts.forEach(function (p, i) {
      svg('circle', {
        cx: sx(i), cy: sy(p.demand || 0), r: 4,
        'fill': '#ffffff', 'stroke': '#0078d4', 'stroke-width': '2'
      }, root);
    });

    // 5. Pinned Callout Box at Nov (month index 10)
    if (co) {
      var calloutIdx = typeof co.month_idx === 'number' ? Math.min(last, co.month_idx) : Math.round(last * 0.83);
      var px = sx(calloutIdx);
      var cw = 144; var ch = 52;
      var bx = Math.max(m.l + 4, Math.min(W - m.r - cw - 4, px - cw / 2));
      var by = sy(reqVal) - ch - 12;
      if (by < m.t - 8) by = m.t - 8;

      // Dotted vertical line dropping down to Nov x-axis
      svg('line', {
        x1: px, x2: px, y1: by + ch, y2: sy(0),
        'stroke': '#d13438', 'stroke-width': '1.2', 'stroke-dasharray': '3 3'
      }, root);

      // Callout box with red dashed border
      svg('rect', {
        x: bx, y: by, width: cw, height: ch, rx: 6,
        'fill': '#ffffff', 'stroke': '#d13438', 'stroke-width': '1.2', 'stroke-dasharray': '3 3'
      }, root);

      var ct = svg('g', {}, root);
      var t1 = svg('text', { x: bx + cw / 2, y: by + 16, 'text-anchor': 'middle', 'style': 'font-size: 10px; font-weight: 600; fill: #d13438;' }, ct);
      t1.textContent = 'Need additional';
      var t2 = svg('text', { x: bx + cw / 2, y: by + 30, 'text-anchor': 'middle', 'style': 'font-size: 10px; font-weight: 600; fill: #d13438;' }, ct);
      t2.textContent = 'capacity by 12 Nov';
      var t3 = svg('text', { x: bx + cw / 2, y: by + 44, 'text-anchor': 'middle', 'style': 'font-size: 10px; font-weight: 600; fill: #d13438;' }, ct);
      t3.textContent = '2026 (5,000 CU)';
    }

    // Hover layer: snaps to nearest point
    var cross = svg('line', { y1: m.t, y2: sy(0), 'class': 'cross', 'stroke': '#8a8886', 'stroke-width': '1', visibility: 'hidden' }, root);
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.display = 'none'; host.appendChild(tip);
    var hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, 'class': 'hit', 'fill': 'transparent' }, root);
    var cur = 0;

    function show(i) {
      cur = i; var p = pts[i]; var x = sx(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = '';
      var hd = document.createElement('div'); hd.className = 'chart-tip__date';
      hd.textContent = (p.month_label || (p.date ? fmtDate(p.date) : MONTHS[i % 12])) + ' 2026';
      tip.appendChild(hd);
      [
        ['Forecast Demand', p.demand || 0, '#0078d4'],
        ['Current Usage', p.usage || 0, '#8764b8'],
        ['Requested Capacity', reqVal, '#d13438']
      ].forEach(function (r) {
        var row = document.createElement('div'); row.className = 'chart-tip__row';
        row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;margin:2px 0;';
        var dot = document.createElement('span');
        dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + r[2] + ';';
        var name = document.createElement('span'); name.textContent = r[0]; name.style.flex = '1';
        var val = document.createElement('b'); val.textContent = n(r[1]) + ' CU';
        row.appendChild(dot); row.appendChild(name); row.appendChild(val); tip.appendChild(row);
      });
      var rect = host.getBoundingClientRect(); var scale = rect.width / W;
      tip.style.display = 'block';
      var tw = tip.offsetWidth; var left = x * scale + 12;
      if (left + tw > rect.width - 4) left = x * scale - tw - 12;
      tip.style.left = Math.max(4, left) + 'px'; tip.style.top = (m.t + 8) * scale + 'px';
    }

    function fromEvent(ev) {
      var r = root.getBoundingClientRect(); var x = (ev.clientX - r.left) / r.width * W;
      return Math.max(0, Math.min(last, Math.round(((x - m.l) / pw) * last)));
    }
    hit.addEventListener('pointermove', function (ev) { show(fromEvent(ev)); });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { show(Math.min(last, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { show(Math.max(0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    });
    root.addEventListener('focus', function () { show(cur); });
  }

  app.directive('capTeamChart', function () {
    return {
      restrict: 'E',
      scope: { data: '=' },
      link: function (scope, element) {
        var host = element[0]; var lastW = 0;
        var draw = function () { lastW = host.clientWidth; renderTeam(host, scope.data); };
        scope.$watch('data', draw);
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { if (Math.abs(host.clientWidth - lastW) > 8) draw(); });
          ro.observe(host);
          scope.$on('$destroy', function () { ro.disconnect(); });
        }
      },
    };
  });

  /* ------------------------------------------------------------------ planned demand against actual (Outcome page)
   * One pool: the last weeks of history, then the demand the plan counted when the lab moved (the forecast with the pipeline
   * and the dated adds on top: middle path dashed, planning path p80 dotted) and the actual readings generated since. A
   * reading above p80 is a triangle, not just a different colour. A pool that filled up also shows its capacity, because
   * the flat top of its actual line is the limit, not the demand. The y axis is fitted to the data, not drawn from zero,
   * because the plan is close and the gap is what the chart is for. Hover or arrow keys read a week; the same values are in
   * the table on the page.
   */
  app.directive('capFeedbackChart', function () {
    return {
      restrict: 'E',
      scope: { data: '=', label: '@' },
      link: function (scope, element) {
        var host = element[0]; var lastW = 0;
        var draw = function () { lastW = host.clientWidth; renderFeedback(host, scope.data, scope.label); };
        scope.$watch('data', draw);
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () { if (Math.abs(host.clientWidth - lastW) > 8) draw(); });
          ro.observe(host);
          scope.$on('$destroy', function () { ro.disconnect(); });
        }
      },
    };
  });

  function renderFeedback(host, d, label) {
    host.innerHTML = '';
    if (!d || !d.rows || !d.rows.length) return;
    var hist = d.history; var rows = d.rows;
    var nh = hist.length; var last = nh + rows.length - 1; var origin = nh - 1;
    var W = Math.max(240, Math.round(host.clientWidth || 380)); var H = 224; var m = { l: 54, r: 12, t: 16, b: 28 };
    var pw = W - m.l - m.r; var ph = H - m.t - m.b;
    var vals = hist.map(function (h) { return h.value; });
    rows.forEach(function (r) { vals.push(r.actual, r.p50, r.p80); });
    // A pool that filled up shows its capacity: the flat top of the actual line is the limit, not the demand.
    var full = rows.some(function (r) { return r.unserved_cu > 0; });
    if (full) rows.forEach(function (r) { vals.push(r.capacity); });
    var lo = Math.min.apply(null, vals); var hi = Math.max.apply(null, vals);
    var step = niceStep(Math.max(1, (hi - lo) * 1.2));
    var bottom = Math.floor(lo / step) * step; var top = Math.ceil(hi / step) * step;
    if (top === bottom) top = bottom + step;
    var sx = function (i) { return m.l + (last ? i / last : 0.5) * pw; };
    var sy = function (v) { return m.t + ph - (v - bottom) / (top - bottom) * ph; };
    var line = function (pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + Math.round(p.x * 10) / 10 + ' ' + Math.round(p.y * 10) / 10; }).join(' '); };

    var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: '0',
      'aria-label': (label ? label + ': ' : '') + 'actual usage against the demand the plan counted when the lab moved. Use the arrow keys to read each week.' }, host);
    var ax = svg('g', { 'class': 'axis' }, root);
    for (var v = bottom; v <= top + 1e-9; v += step) {
      svg('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), 'class': 'grid' }, ax);
      var yl = svg('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end' }, ax); yl.textContent = n(v);
    }
    [[0, 'start', fmtShort(hist[0].week_start)], [last, 'end', fmtShort(rows[rows.length - 1].week_start)]].forEach(function (t) {
      var x = svg('text', { x: sx(t[0]), y: H - 8, 'text-anchor': t[1] }, ax); x.textContent = t[2];
    });
    // where the lab moved, and the date it was written down: kept clear of the end label by sitting above the plot
    svg('line', { x1: sx(origin), x2: sx(origin), y1: m.t, y2: m.t + ph, 'class': 'fb-origin' }, root);
    var ol = svg('text', { x: sx(origin) - 5, y: m.t + 10, 'text-anchor': 'end', 'class': 'fb-originlabel' }, root); ol.textContent = 'Then ' + fmtShort(hist[origin].week_start);

    var start = { x: sx(origin), y: sy(hist[origin].value) };
    if (full) svg('path', { d: line(rows.map(function (r, i) { return { x: sx(nh + i), y: sy(r.capacity) }; })), 'class': 'fb-cap' }, root);
    svg('path', { d: line(hist.map(function (h, i) { return { x: sx(i), y: sy(h.value) }; })), 'class': 'fb-hist' }, root);
    svg('path', { d: line([start].concat(rows.map(function (r, i) { return { x: sx(nh + i), y: sy(r.p80) }; }))), 'class': 'fb-p80' }, root);
    svg('path', { d: line([start].concat(rows.map(function (r, i) { return { x: sx(nh + i), y: sy(r.p50) }; }))), 'class': 'fb-p50' }, root);
    svg('path', { d: line([start].concat(rows.map(function (r, i) { return { x: sx(nh + i), y: sy(r.actual) }; }))), 'class': 'fb-act' }, root);
    rows.forEach(function (r, i) {
      var x = sx(nh + i); var y = sy(r.actual);
      if (r.within_p80) svg('circle', { cx: x, cy: y, r: 3.5, 'class': 'fb-dot' }, root);
      else svg('path', { d: 'M' + x + ' ' + (y - 5.5) + ' L' + (x + 5.5) + ' ' + (y + 4) + ' L' + (x - 5.5) + ' ' + (y + 4) + ' Z', 'class': 'fb-out' }, root);
    });

    var cross = svg('line', { y1: m.t, y2: m.t + ph, 'class': 'cross', visibility: 'hidden' }, root);
    var tip = document.createElement('div'); tip.className = 'chart-tip'; tip.style.display = 'none'; host.appendChild(tip);
    var hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, 'class': 'hit' }, root);
    var cur = origin + 1;
    function row(parent, name, value, keyClass) {
      var el = document.createElement('div'); el.className = 'chart-tip__row';
      var k = document.createElement('span'); k.className = 'key ' + keyClass;
      var nm = document.createElement('span'); nm.textContent = name;
      var b = document.createElement('b'); b.textContent = value;
      el.appendChild(k); el.appendChild(nm); el.appendChild(b); parent.appendChild(el);
    }
    function show(i) {
      cur = i; var x = sx(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = '';
      var hd = document.createElement('div'); hd.className = 'chart-tip__date';
      if (i < nh) {
        hd.textContent = fmtDate(hist[i].week_start) + ' (history)'; tip.appendChild(hd);
        row(tip, 'Reading', n(hist[i].value), 'key--fbhist');
      } else {
        var r = rows[i - nh];
        hd.textContent = fmtDate(r.week_start) + ' (week ' + r.week + ')'; tip.appendChild(hd);
        row(tip, 'Actual', n(r.actual), 'key--fbact');
        row(tip, 'Planned middle', n(r.p50), 'key--fbp50');
        row(tip, 'Planned p80', n(r.p80), 'key--fbp80');
        row(tip, r.within_p80 ? 'Off the middle by' : 'Above p80 by', (r.error >= 0 ? '+' : '') + n(r.error) + ' (' + (r.error_pct >= 0 ? '+' : '') + r.error_pct.toFixed(1) + '%)', 'key--none');
        if (r.dated_cu > 0) row(tip, 'Dated demand in it', '+' + n(r.dated_cu), 'key--none');
        if (r.unserved_cu > 0) row(tip, 'Turned away (pool full)', n(r.unserved_cu), 'key--fbcap');
      }
      var rect = host.getBoundingClientRect(); var scale = rect.width / W;
      tip.style.display = 'block';
      var tw = tip.offsetWidth; var left = x * scale + 12;
      if (left + tw > rect.width - 4) left = x * scale - tw - 12;
      tip.style.left = Math.max(4, left) + 'px'; tip.style.top = (m.t + 6) * scale + 'px';
    }
    function fromEvent(ev) {
      var r = root.getBoundingClientRect(); var x = (ev.clientX - r.left) / r.width * W;
      return Math.max(0, Math.min(last, Math.round(((x - m.l) / pw) * last)));
    }
    hit.addEventListener('pointermove', function (ev) { show(fromEvent(ev)); });
    hit.addEventListener('pointerleave', function () { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { show(Math.min(last, cur + 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { show(Math.max(0, cur - 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    });
    root.addEventListener('focus', function () { show(cur); });
  }

  /* ------------------------------------------------------------------ controller */
  app.controller('LabController', ['$http', '$q', '$location', '$rootScope', '$timeout', function ($http, $q, $location, $rootScope, $timeout) {
    var vm = this;

    vm.page = 'planning';
    vm.planView = 'balance';        // which of the three views of Capacity Planning is open: balance, supply or demand
    vm.plan = null;
    vm.poolId = null;
    vm.audience = store('lab.audience') || 'operations';
    vm.loading = 0;
    vm.error = null;
    vm.notice = null;
    vm.showAll = false;
    vm.openSig = {};
    vm.choice = {};
    vm.labResult = {};
    vm.dec = { by: store('lab.name') || '', qty: null, reason: '', disputed: '' };
    vm.decMsg = null;
    vm.ai = { status: null, result: null, busy: false, copied: false };
    vm.wi = null;
    vm.wiResult = null;
    vm.change = null;
    vm.rq = null;
    vm.rqResult = null;
    vm.cv = { pool_id: null, ratio: null, swap: null };
    vm.cvResult = null;
    vm.ovq = { horizon: 52, sku: 'all', region: 'all' };
    vm.ov = null;
    vm.invTab = 'all';
    vm.queueTab = 'all';
    vm.actions = null;
    vm.actionTab = 'all';
    vm.aqTab = 'all';
    vm.aqSearch = '';
    vm.aqStatus = 'all';
    vm.aqHorizon = '12';
    vm.aqRegion = 'all';
    vm.aqPool = 'all';
    vm.aqPage = 1;

    vm.aqKpis = {
      total: 12,
      at_risk: 3,
      due_soon: 2,
      ai_recommended: 7,
      procurement: 5
    };

    vm.aqTabs = [
      { key: 'all', label: 'All', count: 12 },
      { key: 'deals', label: 'Customer Deals', count: 3 },
      { key: 'launches', label: 'Product Launches', count: 2 },
      { key: 'seasonal', label: 'Seasonal', count: 2 },
      { key: 'transitions', label: 'SKU Transitions', count: 2 },
      { key: 'sustainability', label: 'Sustainability', count: 1 },
      { key: 'regulatory', label: 'Regulatory', count: 1 },
      { key: 'supply_chain', label: 'Supply Chain', count: 2 },
      { key: 'others', label: 'Others', count: 2 }
    ];

    vm.aqRows = [
      {
        priority: 'P0',
        prio_class: 'p0',
        title: 'Large Customer Deal',
        desc: 'New capacity request from strategic customer (Coca-Cola)',
        customer: 'Coca-Cola Analytics',
        region: 'West US',
        cores: '8,000',
        supply: '2,000',
        eng_min: '3,000',
        gap: '5,000',
        gap_class: 'text-danger',
        rev_impact: '$12.0M',
        rev_class: 'text-danger',
        target_date: 'Mar 2025',
        status: 'Partial',
        status_class: 'partial',
        action: 'Plan Phased',
        category: 'deals',
        pool_id: 'pool-westus-01-nvidia-h100'
      },
      {
        priority: 'P0',
        prio_class: 'p0',
        title: 'Product Launch',
        desc: 'New product launch requiring GPU capacity',
        customer: 'Contoso AI Platform',
        region: 'East US',
        cores: '4,000',
        supply: '4,000',
        eng_min: '4,000',
        gap: '0',
        gap_class: 'text-success',
        rev_impact: '—',
        rev_class: 'text-muted',
        target_date: 'Mar 2025',
        status: 'On Track',
        status_class: 'ontrack',
        action: 'Monitor',
        category: 'launches',
        pool_id: 'pool-eastus-01-intel-icx'
      },
      {
        priority: 'P1',
        prio_class: 'p1',
        title: 'Seasonal Demand',
        desc: 'Holiday season expected spike',
        customer: 'Retail Customers',
        region: 'Global',
        cores: '6,000',
        supply: '5,000',
        eng_min: '5,000',
        gap: '1000',
        gap_class: 'text-danger',
        rev_impact: '$2.4M',
        rev_class: 'text-danger',
        target_date: 'Nov 2025',
        status: 'At Risk',
        status_class: 'atrisk',
        action: 'Increase Supply',
        category: 'seasonal',
        pool_id: 'pool-westeurope-01-amd-genoa'
      },
      {
        priority: 'P1',
        prio_class: 'p1',
        title: 'SKU Transition',
        desc: 'Intel → AMD migration (EOL)',
        customer: 'Internal Workloads',
        region: 'Central US',
        cores: '3,200',
        supply: '3,200',
        eng_min: '3,000',
        gap: '0',
        gap_class: 'text-success',
        rev_impact: '—',
        rev_class: 'text-muted',
        target_date: 'Jun 2025',
        status: 'Planned',
        status_class: 'planned',
        action: 'Execute',
        category: 'transitions',
        pool_id: 'pool-centralus-01-intel-icx'
      },
      {
        priority: 'P2',
        prio_class: 'p2',
        title: 'Sustainability',
        desc: 'High carbon footprint – older SKU',
        customer: 'Batch Processing',
        region: 'North Europe',
        cores: '1,000',
        supply: '1,000',
        eng_min: '1,000',
        gap: '0',
        gap_class: 'text-success',
        rev_impact: '—',
        rev_class: 'text-muted',
        target_date: 'Sep 2025',
        status: 'Planned',
        status_class: 'planned',
        action: 'Migrate SKU',
        category: 'sustainability',
        pool_id: 'pool-northeurope-01-nvidia-a100'
      },
      {
        priority: 'P2',
        prio_class: 'p2',
        title: 'Regulatory / Compliance',
        desc: 'Data residency requirement',
        customer: 'EU Customer',
        region: 'Germany',
        cores: '2,000',
        supply: '1,500',
        eng_min: '2,000',
        gap: '500',
        gap_class: 'text-danger',
        rev_impact: '$1.2M',
        rev_class: 'text-danger',
        target_date: 'Jul 2025',
        status: 'At Risk',
        status_class: 'atrisk',
        action: 'Reallocate',
        category: 'regulatory',
        pool_id: 'pool-germanywestcentral-01-intel-skx'
      },
      {
        priority: 'P3',
        prio_class: 'p3',
        title: 'Supply Chain Constraint',
        desc: 'Provider lead time limited',
        customer: 'GPU Cluster',
        region: 'East Asia',
        cores: '1,400',
        supply: '700',
        eng_min: '1,000',
        gap: '700',
        gap_class: 'text-danger',
        rev_impact: '$0.8M',
        rev_class: 'text-danger',
        target_date: 'May 2025',
        status: 'At Risk',
        status_class: 'atrisk',
        action: 'Expedite Order',
        category: 'supply_chain',
        pool_id: 'pool-southeastasia-01-amd-genoa'
      }
    ];

    vm.sfHorizon = '12';
    vm.sfRegion = 'all';
    vm.sfPool = 'all';
    vm.sfSearch = '';
    vm.sfCategory = 'all';
    vm.sfTableRegion = 'all';
    vm.sfTablePool = 'all';
    vm.sfStatus = 'all';

    vm.sfKpis = {
      total: 14,
      active: 12,
      active_delta: '+ 12%',
      active_sub: '+5 Since Last Week',
      high_risk: 11,
      avg_time: '9.2',
      pools_at_risk: '06',
      projected_spend: '$12.4M'
    };

    vm.signalRows = [
      {
        num: 1,
        name: 'Demand',
        icon: 'i-pulse',
        icon_color: 'purple',
        impact_val: '+1,469 CU',
        impact_sub: 'Capacity Required',
        is_high_impact: true,
        risk_pools: 6,
        last_updated: '7 Sep 2026',
        status: 'High',
        status_class: 'high',
        action: 'Procure',
        category: 'demand'
      },
      {
        num: 2,
        name: 'Reliability / Health',
        icon: 'i-heart',
        icon_color: 'pink',
        impact_val: '1,020 CU',
        impact_sub: 'Replacement Needed',
        is_high_impact: true,
        risk_pools: 3,
        last_updated: '7 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Replacement',
        category: 'health'
      },
      {
        num: 3,
        name: 'Performance',
        icon: 'i-bolt',
        icon_color: 'blue',
        impact_val: '640 CU',
        impact_sub: 'Additional Capacity',
        is_high_impact: true,
        risk_pools: 4,
        last_updated: '6 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Review',
        category: 'performance'
      },
      {
        num: 4,
        name: 'Cost & Efficiency',
        icon: 'i-target',
        icon_color: 'green',
        impact_val: '520 CU',
        impact_sub: 'Reclaim Opportunity',
        is_high_impact: true,
        risk_pools: 2,
        last_updated: '6 Sep 2026',
        status: 'Low',
        status_class: 'low',
        action: 'Reclaim',
        category: 'cost'
      },
      {
        num: 5,
        name: 'SKU Lifecycle',
        icon: 'i-grid',
        icon_color: 'blue',
        impact_val: '1,200 CU',
        impact_sub: 'Migration Required',
        is_high_impact: true,
        risk_pools: 5,
        last_updated: '6 Sep 2026',
        status: 'High',
        status_class: 'high',
        action: 'Migration',
        category: 'lifecycle'
      },
      {
        num: 6,
        name: 'Supply Chain / Lead Time',
        icon: 'i-cart',
        icon_color: 'purple',
        impact_val: '880 CU',
        impact_sub: 'Early Procurement',
        is_high_impact: true,
        risk_pools: 3,
        last_updated: '6 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Procure',
        category: 'supply_chain'
      },
      {
        num: 7,
        name: 'Security & Compliance',
        icon: 'i-shield',
        icon_color: 'blue',
        impact_val: '360 CU',
        impact_sub: 'Capacity for isolation',
        is_high_impact: true,
        risk_pools: 2,
        last_updated: '5 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Isolation',
        category: 'security'
      },
      {
        num: 8,
        name: 'Seasonal / Event Driven',
        icon: 'i-calendar',
        icon_color: 'purple',
        impact_val: '980 CU',
        impact_sub: 'Temporary Capacity',
        is_high_impact: true,
        risk_pools: 4,
        last_updated: '5 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Review',
        category: 'seasonal'
      },
      {
        num: 9,
        name: 'Competitive / Market Signal',
        icon: 'i-users',
        icon_color: 'green',
        impact_val: '1,100 CU',
        impact_sub: 'Growth Capacity',
        is_high_impact: true,
        risk_pools: 3,
        last_updated: '5 Sep 2026',
        status: 'High',
        status_class: 'high',
        action: 'Review',
        category: 'market'
      },
      {
        num: 10,
        name: 'Customer Contract & Commitment',
        icon: 'i-doc',
        icon_color: 'amber',
        impact_val: '760 CU',
        impact_sub: 'Contractual Buffer',
        is_high_impact: false,
        risk_pools: 2,
        last_updated: '4 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Review',
        category: 'contracts'
      },
      {
        num: 11,
        name: 'Technology Shift',
        icon: 'i-cpu',
        icon_color: 'blue',
        impact_val: '620 CU',
        impact_sub: 'Architecture Modernization',
        is_high_impact: false,
        risk_pools: 2,
        last_updated: '4 Sep 2026',
        status: 'Low',
        status_class: 'low',
        action: 'Review',
        category: 'tech_shift'
      },
      {
        num: 12,
        name: 'Sustainability & Carbon',
        icon: 'i-leaf',
        icon_color: 'green',
        impact_val: '450 CU',
        impact_sub: 'Green Region Shift',
        is_high_impact: false,
        risk_pools: 2,
        last_updated: '4 Sep 2026',
        status: 'Low',
        status_class: 'low',
        action: 'Review',
        category: 'sustainability'
      },
      {
        num: 13,
        name: 'Regulatory Compliance',
        icon: 'i-circle-alert',
        icon_color: 'pink',
        impact_val: '580 CU',
        impact_sub: 'Data Sovereignty Ring',
        is_high_impact: true,
        risk_pools: 1,
        last_updated: '3 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Isolate',
        category: 'regulatory'
      },
      {
        num: 14,
        name: 'Regional Strategy',
        icon: 'i-globe',
        icon_color: 'purple',
        impact_val: '820 CU',
        impact_sub: 'Expansion Allocation',
        is_high_impact: true,
        risk_pools: 3,
        last_updated: '3 Sep 2026',
        status: 'Medium',
        status_class: 'medium',
        action: 'Review',
        category: 'regional'
      }
    ];

    vm.filteredSignalRows = function () {
      var rows = vm.signalRows || [];
      if (vm.sfStatus && vm.sfStatus !== 'all') {
        rows = rows.filter(function (r) { return r.status_class === vm.sfStatus; });
      }
      if (vm.sfCategory && vm.sfCategory !== 'all') {
        rows = rows.filter(function (r) { return r.category === vm.sfCategory; });
      }
      if (vm.sfSearch && vm.sfSearch.trim()) {
        var s = vm.sfSearch.toLowerCase().trim();
        rows = rows.filter(function (r) {
          return r.name.toLowerCase().indexOf(s) >= 0 ||
                 r.impact_sub.toLowerCase().indexOf(s) >= 0 ||
                 r.action.toLowerCase().indexOf(s) >= 0;
        });
      }
      return rows;
    };

    vm.signalDetails = {
      demand: {
        id: 'demand',
        name: 'Demand',
        status: 'High Risk',
        status_label: 'High Risk',
        status_class: 'high',
        desc: 'New Customer Workloads and Forecasted Growth',
        owner: 'Capacity Planning Team',
        region: 'East US',
        last_updated: '7 Sep 2026, 10:24 AM',
        icon: 'i-pulse',
        icon_color: 'purple',
        rec_action: {
          title: 'Procure 731 CU',
          desc: 'Additional capacity required to meet forecasted demand. Initiate procurement now to ensure availability before 12 Nov 2026.',
          total_required: '3,200 CU',
          current_cap: '2,469 CU',
          target_avail: '12 Nov 2026',
          lead_time: '12 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'East US'
        },
        evidence_as_of: '7 Sep 2026',
        evidence_items: [
          { label: 'Current Utilisation', val: '61.7%', badge: '▲ +12.5%', sub: '2,469 / 4,000 CU', icon: 'i-server', color: 'blue' },
          { label: 'Workload Growth Rate', val: '+1.98 pts/week', badge: null, sub: 'vs previous 8 weeks', icon: 'i-pulse', color: 'purple' },
          { label: 'Used Capacity', val: '2,469 CU', badge: '▲ +18%', sub: 'vs previous period', icon: 'i-cube', color: 'blue' },
          { label: 'Historical Trend', val: '16 weeks', badge: null, sub: 'of consistent growth', icon: 'i-chart-bar', color: 'purple' }
        ],
        chart: {
          today_pct: '61.7%',
          today_val: '2,469 CU',
          threshold_pct: '80%',
          threshold_val: '3,200 CU',
          lead_weeks: '9.2',
          lead_date: '12 Nov 2026'
        },
        decision: {
          alert_title: 'Action required (Overdue)',
          alert_desc: 'Projected utilisation will reach 80% in 9.2 weeks, which is earlier than the procurement lead time of 12 weeks.',
          threshold: '80%',
          threshold_date: '12 Nov 2026 (9.2 weeks)',
          lead_time: '12 weeks',
          buffer: '0 Weeks',
          action_window: '-2.8 Weeks (Missed)',
          is_overdue: true
        }
      },
      health: {
        id: 'health',
        name: 'Reliability / Health',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Hardware Failure Rates, MTBF Degradation and Redundancy Reserves',
        owner: 'Reliability Engineering',
        region: 'Europe',
        last_updated: '7 Sep 2026, 09:15 AM',
        icon: 'i-heart',
        icon_color: 'pink',
        rec_action: {
          title: 'Increase DR Reserve by 600 CU',
          desc: 'Hardware fault frequency in Europe cluster requires additional headroom buffer to maintain 99.99% SLA.',
          total_required: '1,020 CU',
          current_cap: '420 CU',
          target_avail: '20 Nov 2026',
          lead_time: '8 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'Europe'
        },
        evidence_as_of: '7 Sep 2026',
        evidence_items: [
          { label: 'Incident Count (30d)', val: '14 incidents', badge: '▲ +22%', sub: '3 clusters affected', icon: 'i-alert', color: 'pink' },
          { label: 'Unscheduled Downtime', val: '0.04%', badge: null, sub: 'Target < 0.01%', icon: 'i-clock', color: 'amber' },
          { label: 'Hardware Replacement', val: '1,020 CU', badge: '▲ +15%', sub: 'Replacement needed', icon: 'i-server', color: 'blue' },
          { label: 'Resilience Margin', val: '4.8%', badge: null, sub: 'Below 10% target', icon: 'i-shield', color: 'purple' }
        ],
        chart: {
          today_pct: '72.4%',
          today_val: '1,020 CU',
          threshold_pct: '85%',
          threshold_val: '1,200 CU',
          lead_weeks: '7.8',
          lead_date: '20 Nov 2026'
        },
        decision: {
          alert_title: 'Action required (Planned)',
          alert_desc: 'Incident frequency indicates need for spare chassis replenishment before expected seasonal peak.',
          threshold: '85%',
          threshold_date: '20 Nov 2026 (7.8 weeks)',
          lead_time: '8 weeks',
          buffer: '1 Week',
          action_window: '0.8 Weeks (Tight)',
          is_overdue: false
        }
      },
      performance: {
        id: 'performance',
        name: 'Performance',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Latency Spikes, Queue Depths and Tail Response Thresholds',
        owner: 'Performance & Benchmarking',
        region: 'West US',
        last_updated: '6 Sep 2026, 04:30 PM',
        icon: 'i-bolt',
        icon_color: 'blue',
        rec_action: {
          title: 'Add 640 CU Performance Buffer',
          desc: 'Compute queue depth exceeds p99 latency guarantees during peak batch ingestion windows.',
          total_required: '2,800 CU',
          current_cap: '2,160 CU',
          target_avail: '05 Dec 2026',
          lead_time: '6 weeks',
          successor_sku: 'FAB-NV-H100-80',
          region: 'West US'
        },
        evidence_as_of: '6 Sep 2026',
        evidence_items: [
          { label: 'P99 Latency', val: '184 ms', badge: '▲ +34%', sub: 'SLA threshold 150 ms', icon: 'i-bolt', color: 'blue' },
          { label: 'Queue Throttling', val: '4.2% reqs', badge: null, sub: 'Peak hour spikes', icon: 'i-queue', color: 'purple' },
          { label: 'Buffer Needed', val: '640 CU', badge: '▲ +8%', sub: 'Additional capacity', icon: 'i-cube', color: 'blue' },
          { label: 'High-Load Duration', val: '6.4 hrs/day', badge: null, sub: 'vs 3.1 hrs normal', icon: 'i-clock', color: 'amber' }
        ],
        chart: {
          today_pct: '78.1%',
          today_val: '2,160 CU',
          threshold_pct: '85%',
          threshold_val: '2,800 CU',
          lead_weeks: '6.4',
          lead_date: '05 Dec 2026'
        },
        decision: {
          alert_title: 'Action required (Review)',
          alert_desc: 'P99 SLA breach risks will increase if workload surge continues without buffer expansion.',
          threshold: '85%',
          threshold_date: '05 Dec 2026 (6.4 weeks)',
          lead_time: '6 weeks',
          buffer: '2 Weeks',
          action_window: '+0.4 Weeks (Active)',
          is_overdue: false
        }
      },
      cost: {
        id: 'cost',
        name: 'Cost & Efficiency',
        status: 'Low Risk',
        status_label: 'Low Risk',
        status_class: 'low',
        desc: 'Underutilized Compute, Rightsizing Opportunities and Reclaim Potential',
        owner: 'FinOps & Cost Management',
        region: 'Central US',
        last_updated: '6 Sep 2026, 02:10 PM',
        icon: 'i-target',
        icon_color: 'green',
        rec_action: {
          title: 'Reclaim 520 CU Idle Capacity',
          desc: 'Identify dormant customer test allocations and downsize idle worker nodes for cost savings.',
          total_required: '1,400 CU',
          current_cap: '1,920 CU',
          target_avail: '15 Oct 2026',
          lead_time: '2 weeks',
          successor_sku: 'FAB-INTEL-ICX-64',
          region: 'Central US'
        },
        evidence_as_of: '6 Sep 2026',
        evidence_items: [
          { label: 'Idle Capacity Share', val: '27.1%', badge: '▼ -4.2%', sub: '520 CU reclaimable', icon: 'i-target', color: 'green' },
          { label: 'Projected Monthly Savings', val: '$140K', badge: null, sub: 'Annualized $1.68M', icon: 'i-dollar', color: 'green' },
          { label: 'Unallocated Reserv.', val: '310 CU', badge: '▼ -12%', sub: 'Dormant leases', icon: 'i-box', color: 'blue' },
          { label: 'Reclaim Cycle', val: '4 pools', badge: null, sub: 'Ready for cleanup', icon: 'i-layers', color: 'purple' }
        ],
        chart: {
          today_pct: '52.0%',
          today_val: '1,400 CU',
          threshold_pct: '70%',
          threshold_val: '1,920 CU',
          lead_weeks: '18.0',
          lead_date: '15 Jan 2027'
        },
        decision: {
          alert_title: 'Optimization Opportunity',
          alert_desc: 'Reclaiming 520 CU will free up quota without requiring external hardware purchase.',
          threshold: '70%',
          threshold_date: '15 Jan 2027 (18 weeks)',
          lead_time: '2 weeks',
          buffer: '4 Weeks',
          action_window: '+16 Weeks (Optimal)',
          is_overdue: false
        }
      },
      lifecycle: {
        id: 'lifecycle',
        name: 'SKU Lifecycle',
        status: 'High Risk',
        status_label: 'High Risk',
        status_class: 'high',
        desc: 'Hardware End-of-Life, Vendor Deprecation and Architecture Migrations',
        owner: 'Hardware Lifecycle Team',
        region: 'Central US',
        last_updated: '6 Sep 2026, 11:00 AM',
        icon: 'i-grid',
        icon_color: 'blue',
        rec_action: {
          title: 'Migrate 1,200 CU to Gen5',
          desc: 'Intel ICX SKU reaches end-of-life in Q1 2027. Initiate transition to AMD Genoa clusters.',
          total_required: '1,200 CU',
          current_cap: '1,200 CU',
          target_avail: '15 Jan 2027',
          lead_time: '14 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'Central US'
        },
        evidence_as_of: '6 Sep 2026',
        evidence_items: [
          { label: 'EOL Runway', val: '14 weeks', badge: '▼ EOL Q1', sub: 'Vendor support ceases', icon: 'i-clock', color: 'amber' },
          { label: 'Affected Tenants', val: '18 tenants', badge: null, sub: 'Must complete swap', icon: 'i-users', color: 'blue' },
          { label: 'Replacement Needed', val: '1,200 CU', badge: '▲ Gen5', sub: 'Target Genoa SKU', icon: 'i-swap', color: 'purple' },
          { label: 'Failure Probability', val: '3.4 ×', badge: null, sub: 'Higher on aged silicon', icon: 'i-alert', color: 'pink' }
        ],
        chart: {
          today_pct: '88.5%',
          today_val: '1,200 CU',
          threshold_pct: '90%',
          threshold_val: '1,200 CU',
          lead_weeks: '10.5',
          lead_date: '15 Jan 2027'
        },
        decision: {
          alert_title: 'Action required (Critical)',
          alert_desc: 'Transition must be executed in phases before vendor support expiration to avoid unpatched firmware risks.',
          threshold: '90%',
          threshold_date: '15 Jan 2027 (10.5 weeks)',
          lead_time: '14 weeks',
          buffer: '0 Weeks',
          action_window: '-3.5 Weeks (Critical)',
          is_overdue: true
        }
      },
      supply_chain: {
        id: 'supply_chain',
        name: 'Supply Chain / Lead Time',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Component Lead Times, Fabrication Delays and Vendor Commitments',
        owner: 'Global Supply Chain',
        region: 'East US',
        last_updated: '6 Sep 2026, 08:45 AM',
        icon: 'i-cart',
        icon_color: 'purple',
        rec_action: {
          title: 'Early Procurement 880 CU',
          desc: 'Supplier factory lead times have increased from 8 to 12 weeks. Order placement must accelerate.',
          total_required: '2,500 CU',
          current_cap: '1,620 CU',
          target_avail: '12 Nov 2026',
          lead_time: '12 weeks',
          successor_sku: 'FAB-NV-H100-80',
          region: 'East US'
        },
        evidence_as_of: '6 Sep 2026',
        evidence_items: [
          { label: 'Vendor Lead Time', val: '12 weeks', badge: '▲ +4 wks', sub: 'Extended lead time', icon: 'i-cart', color: 'purple' },
          { label: 'Supply Buffer', val: '3 weeks', badge: null, sub: 'Down from 6 weeks', icon: 'i-clock', color: 'amber' },
          { label: 'Early PO Volume', val: '880 CU', badge: '▲ +20%', sub: 'Pre-allocation', icon: 'i-cube', color: 'blue' },
          { label: 'Vendor Fulfillment', val: '91.2%', badge: null, sub: 'Historic on-time rate', icon: 'i-check-circle', color: 'green' }
        ],
        chart: {
          today_pct: '64.8%',
          today_val: '1,620 CU',
          threshold_pct: '80%',
          threshold_val: '2,500 CU',
          lead_weeks: '9.5',
          lead_date: '12 Nov 2026'
        },
        decision: {
          alert_title: 'Action required (Lead Time Mismatch)',
          alert_desc: 'Vendor delivery latency exceeds runway by 2.5 weeks; purchase requisition must be expedited.',
          threshold: '80%',
          threshold_date: '12 Nov 2026 (9.5 weeks)',
          lead_time: '12 weeks',
          buffer: '0 Weeks',
          action_window: '-2.5 Weeks (Late)',
          is_overdue: true
        }
      },
      security: {
        id: 'security',
        name: 'Security & Compliance',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Confidential Computing Demands, Isolation Enclaves and Regulatory Audits',
        owner: 'Security & Compliance Team',
        region: 'North Europe',
        last_updated: '5 Sep 2026, 03:20 PM',
        icon: 'i-shield',
        icon_color: 'blue',
        rec_action: {
          title: 'Allocate 360 CU for Isolation',
          desc: 'Tenant isolation mandates require dedicated enclave hardware in North Europe region.',
          total_required: '1,800 CU',
          current_cap: '1,440 CU',
          target_avail: '28 Oct 2026',
          lead_time: '6 weeks',
          successor_sku: 'FAB-NV-A100-80',
          region: 'North Europe'
        },
        evidence_as_of: '5 Sep 2026',
        evidence_items: [
          { label: 'Enclave Utilization', val: '92.4%', badge: '▲ +14%', sub: 'High isolation load', icon: 'i-shield', color: 'blue' },
          { label: 'Audited Tenants', val: '8 customers', badge: null, sub: 'Strict isolation SLAs', icon: 'i-users', color: 'purple' },
          { label: 'Capacity Gap', val: '360 CU', badge: '▲ Critical', sub: 'Enclave requirement', icon: 'i-server', color: 'blue' },
          { label: 'Compliance Score', val: '98.5%', badge: null, sub: 'Meets ISO/SOC targets', icon: 'i-check-circle', color: 'green' }
        ],
        chart: {
          today_pct: '80.0%',
          today_val: '1,440 CU',
          threshold_pct: '85%',
          threshold_val: '1,800 CU',
          lead_weeks: '5.2',
          lead_date: '28 Oct 2026'
        },
        decision: {
          alert_title: 'Action required (Isolation SLA)',
          alert_desc: 'Security enclaves approaching maximum density; failure to isolate will delay financial tenant onboardings.',
          threshold: '85%',
          threshold_date: '28 Oct 2026 (5.2 weeks)',
          lead_time: '6 weeks',
          buffer: '1 Week',
          action_window: '-0.8 Weeks (Tight)',
          is_overdue: false
        }
      },
      seasonal: {
        id: 'seasonal',
        name: 'Seasonal / Event Driven',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Holiday E-Commerce Spikes, Black Friday Surge and Annual Reporting Cycles',
        owner: 'Events Planning Team',
        region: 'West Europe',
        last_updated: '5 Sep 2026, 01:10 PM',
        icon: 'i-calendar',
        icon_color: 'purple',
        rec_action: {
          title: 'Provision 980 CU Seasonal Buffer',
          desc: 'Expected 45% workload surge starting mid-November requires temporary burst capacity reservation.',
          total_required: '3,400 CU',
          current_cap: '2,420 CU',
          target_avail: '15 Nov 2026',
          lead_time: '8 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'West Europe'
        },
        evidence_as_of: '5 Sep 2026',
        evidence_items: [
          { label: 'Seasonal Peak Uplift', val: '+45.0%', badge: '▲ Spike', sub: 'Historical Black Friday', icon: 'i-calendar', color: 'purple' },
          { label: 'Duration of Spike', val: '6 weeks', badge: null, sub: 'Nov 15 - Dec 31', icon: 'i-clock', color: 'amber' },
          { label: 'Temporary Capacity', val: '980 CU', badge: '▲ Needed', sub: 'Non-permanent PO', icon: 'i-cube', color: 'blue' },
          { label: 'Revenue at Risk', val: '$2.4M', badge: null, sub: 'Retail partner contracts', icon: 'i-dollar', color: 'green' }
        ],
        chart: {
          today_pct: '71.2%',
          today_val: '2,420 CU',
          threshold_pct: '85%',
          threshold_val: '3,400 CU',
          lead_weeks: '7.5',
          lead_date: '15 Nov 2026'
        },
        decision: {
          alert_title: 'Action required (Time-Critical)',
          alert_desc: 'Burst capacity agreements must be finalized before carrier freeze dates in late October.',
          threshold: '85%',
          threshold_date: '15 Nov 2026 (7.5 weeks)',
          lead_time: '8 weeks',
          buffer: '1 Week',
          action_window: '-0.5 Weeks (Immediate)',
          is_overdue: false
        }
      },
      market: {
        id: 'market',
        name: 'Competitive / Market Signal',
        status: 'High Risk',
        status_label: 'High Risk',
        status_class: 'high',
        desc: 'Third-Party Cloud Pricing Movements, Market Share Growth and LLM Demand Shifts',
        owner: 'Product Strategy & Intelligence',
        region: 'East US',
        last_updated: '5 Sep 2026, 10:05 AM',
        icon: 'i-users',
        icon_color: 'green',
        rec_action: {
          title: 'Procure 1,100 CU Growth Buffer',
          desc: 'Market demand in East US LLM training clusters accelerated 28% following regional service launch.',
          total_required: '3,800 CU',
          current_cap: '2,700 CU',
          target_avail: '01 Dec 2026',
          lead_time: '10 weeks',
          successor_sku: 'FAB-NV-H100-80',
          region: 'East US'
        },
        evidence_as_of: '5 Sep 2026',
        evidence_items: [
          { label: 'Market Ingestion Rate', val: '+28.4%', badge: '▲ High', sub: 'YoY regional expansion', icon: 'i-users', color: 'green' },
          { label: 'Pipeline Requests', val: '24 deals', badge: null, sub: 'Late-stage pipeline', icon: 'i-queue', color: 'purple' },
          { label: 'Uncommitted Headroom', val: '410 CU', badge: '▼ Low', sub: 'Under 10% threshold', icon: 'i-box', color: 'blue' },
          { label: 'Strategic Value', val: '$5.8M', badge: null, sub: 'Enterprise tier accounts', icon: 'i-dollar', color: 'green' }
        ],
        chart: {
          today_pct: '71.0%',
          today_val: '2,700 CU',
          threshold_pct: '80%',
          threshold_val: '3,800 CU',
          lead_weeks: '8.4',
          lead_date: '01 Dec 2026'
        },
        decision: {
          alert_title: 'Action required (Overdue)',
          alert_desc: 'Enterprise accounts entering onboarding will stall within 8.4 weeks without expedited capacity allocation.',
          threshold: '80%',
          threshold_date: '01 Dec 2026 (8.4 weeks)',
          lead_time: '10 weeks',
          buffer: '0 Weeks',
          action_window: '-1.6 Weeks (Missed)',
          is_overdue: true
        }
      },
      contracts: {
        id: 'contracts',
        name: 'Customer Contract & Commitment',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'Signed Contract Commitments, SLA Penalties and Guaranteed Minima',
        owner: 'Commercial Contracts',
        region: 'Central US',
        last_updated: '4 Sep 2026, 04:40 PM',
        icon: 'i-doc',
        icon_color: 'amber',
        rec_action: {
          title: 'Reserve 760 CU Contract Buffer',
          desc: 'Signed Enterprise Tier-1 agreement mandates reserved unshared compute pool by mid-December.',
          total_required: '2,600 CU',
          current_cap: '1,840 CU',
          target_avail: '15 Dec 2026',
          lead_time: '8 weeks',
          successor_sku: 'FAB-INTEL-ICX-64',
          region: 'Central US'
        },
        evidence_as_of: '4 Sep 2026',
        evidence_items: [
          { label: 'Guaranteed Capacity', val: '760 CU', badge: '▲ Contract', sub: 'Binding legal SLA', icon: 'i-doc', color: 'amber' },
          { label: 'Contract Value', val: '$12.0M', badge: null, sub: 'Multi-year commitment', icon: 'i-dollar', color: 'green' },
          { label: 'Penalty Threshold', val: '99.95%', badge: null, sub: 'Availability clause', icon: 'i-shield', color: 'blue' },
          { label: 'Effective Date', val: '15 Dec 2026', badge: null, sub: 'Go-live deadline', icon: 'i-calendar', color: 'purple' }
        ],
        chart: {
          today_pct: '70.8%',
          today_val: '1,840 CU',
          threshold_pct: '80%',
          threshold_val: '2,600 CU',
          lead_weeks: '9.0',
          lead_date: '15 Dec 2026'
        },
        decision: {
          alert_title: 'Action required (Committed)',
          alert_desc: 'Contract commitment SLA requires pre-provisioning buffer prior to tenant verification date.',
          threshold: '80%',
          threshold_date: '15 Dec 2026 (9.0 weeks)',
          lead_time: '8 weeks',
          buffer: '1 Week',
          action_window: '+1.0 Weeks (Active)',
          is_overdue: false
        }
      },
      tech_shift: {
        id: 'tech_shift',
        name: 'Technology Shift',
        status: 'Low Risk',
        status_label: 'Low Risk',
        status_class: 'low',
        desc: 'Microservices Modernization, Containerization and Accelerator Transitions',
        owner: 'Core Architecture Team',
        region: 'West US',
        last_updated: '4 Sep 2026, 02:15 PM',
        icon: 'i-cpu',
        icon_color: 'blue',
        rec_action: {
          title: 'Repurpose 620 CU to Modern Stack',
          desc: 'Transition legacy virtualized nodes to containerized microservice host pools.',
          total_required: '2,000 CU',
          current_cap: '1,380 CU',
          target_avail: '20 Jan 2027',
          lead_time: '6 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'West US'
        },
        evidence_as_of: '4 Sep 2026',
        evidence_items: [
          { label: 'Legacy Footprint', val: '620 CU', badge: '▼ -18%', sub: 'Scheduled for conversion', icon: 'i-cpu', color: 'blue' },
          { label: 'Efficiency Gain', val: '+24.5%', badge: null, sub: 'Compute density uplift', icon: 'i-target', color: 'green' },
          { label: 'Modern Cluster Util', val: '69.0%', badge: null, sub: 'Healthy utilization', icon: 'i-server', color: 'blue' },
          { label: 'Migration Window', val: '12 weeks', badge: null, sub: 'Phase 2 execution', icon: 'i-clock', color: 'purple' }
        ],
        chart: {
          today_pct: '69.0%',
          today_val: '1,380 CU',
          threshold_pct: '80%',
          threshold_val: '2,000 CU',
          lead_weeks: '14.2',
          lead_date: '20 Jan 2027'
        },
        decision: {
          alert_title: 'Optimization In Progress',
          alert_desc: 'Workload modernization progressing according to architectural transformation roadmap.',
          threshold: '80%',
          threshold_date: '20 Jan 2027 (14.2 weeks)',
          lead_time: '6 weeks',
          buffer: '4 Weeks',
          action_window: '+8.2 Weeks (On Track)',
          is_overdue: false
        }
      },
      sustainability: {
        id: 'sustainability',
        name: 'Sustainability & Carbon',
        status: 'Low Risk',
        status_label: 'Low Risk',
        status_class: 'low',
        desc: 'Carbon Intensity Shifting, Renewable Energy Windows and PUE Limits',
        owner: 'Sustainability Office',
        region: 'North Europe',
        last_updated: '4 Sep 2026, 09:30 AM',
        icon: 'i-leaf',
        icon_color: 'green',
        rec_action: {
          title: 'Shift 450 CU to Low-Carbon Hours',
          desc: 'Automate deferrable batch computational tasks to time windows with >85% renewable grid supply.',
          total_required: '1,500 CU',
          current_cap: '1,050 CU',
          target_avail: '01 Nov 2026',
          lead_time: '4 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'North Europe'
        },
        evidence_as_of: '4 Sep 2026',
        evidence_items: [
          { label: 'Carbon Intensity', val: '142 gCO2/kWh', badge: '▼ -32%', sub: 'Renewable grid match', icon: 'i-leaf', color: 'green' },
          { label: 'Shiftable Workloads', val: '450 CU', badge: null, sub: 'Non-interactive batches', icon: 'i-clock', color: 'purple' },
          { label: 'PUE Performance', val: '1.14', badge: '▲ Optimal', sub: 'Industry leading PUE', icon: 'i-target', color: 'green' },
          { label: 'CO2 Reduction Target', val: '280 Tons', badge: null, sub: 'Annual emissions saved', icon: 'i-globe', color: 'blue' }
        ],
        chart: {
          today_pct: '70.0%',
          today_val: '1,050 CU',
          threshold_pct: '80%',
          threshold_val: '1,500 CU',
          lead_weeks: '12.0',
          lead_date: '01 Nov 2026'
        },
        decision: {
          alert_title: 'Sustainability Compliant',
          alert_desc: 'Carbon optimization algorithms successfully dispatching batch compute during low-carbon grid windows.',
          threshold: '80%',
          threshold_date: '01 Nov 2026 (12 weeks)',
          lead_time: '4 weeks',
          buffer: '4 Weeks',
          action_window: '+8.0 Weeks (Healthy)',
          is_overdue: false
        }
      },
      regulatory: {
        id: 'regulatory',
        name: 'Regulatory Compliance',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'EU Data Boundary, GDPR Residency Rules and Sovereign Cloud Enclaves',
        owner: 'Regulatory & Legal',
        region: 'Germany West Central',
        last_updated: '3 Sep 2026, 05:10 PM',
        icon: 'i-circle-alert',
        icon_color: 'pink',
        rec_action: {
          title: 'Isolate 580 CU Sovereign Pool',
          desc: 'German healthcare and financial regulation requires strict in-country data residency without cross-region failover.',
          total_required: '2,200 CU',
          current_cap: '1,620 CU',
          target_avail: '10 Nov 2026',
          lead_time: '8 weeks',
          successor_sku: 'FAB-INTEL-SKX-32',
          region: 'Germany West Central'
        },
        evidence_as_of: '3 Sep 2026',
        evidence_items: [
          { label: 'In-Country Requirement', val: '100% data', badge: '▲ Audit', sub: 'Zero spillover permitted', icon: 'i-circle-alert', color: 'pink' },
          { label: 'Regional Capacity Cap', val: '580 CU needed', badge: null, sub: 'Sovereign cluster', icon: 'i-server', color: 'blue' },
          { label: 'Audit Deadline', val: '10 Nov 2026', badge: null, sub: 'Regulatory review date', icon: 'i-calendar', color: 'purple' },
          { label: 'Fines Risk', val: '$1.8M', badge: null, sub: 'Regulatory compliance penalty', icon: 'i-dollar', color: 'green' }
        ],
        chart: {
          today_pct: '73.6%',
          today_val: '1,620 CU',
          threshold_pct: '85%',
          threshold_val: '2,200 CU',
          lead_weeks: '7.2',
          lead_date: '10 Nov 2026'
        },
        decision: {
          alert_title: 'Action required (Compliance)',
          alert_desc: 'Sovereignty buffer must be commissioned before regulatory validation deadline.',
          threshold: '85%',
          threshold_date: '10 Nov 2026 (7.2 weeks)',
          lead_time: '8 weeks',
          buffer: '1 Week',
          action_window: '-0.8 Weeks (Tight)',
          is_overdue: false
        }
      },
      regional: {
        id: 'regional',
        name: 'Regional Strategy',
        status: 'Medium Risk',
        status_label: 'Medium Risk',
        status_class: 'medium',
        desc: 'New Datacenter Availability Zones, WAN Interconnects and Geo-Expansion',
        owner: 'Regional Infrastructure Planning',
        region: 'Southeast Asia',
        last_updated: '3 Sep 2026, 02:40 PM',
        icon: 'i-globe',
        icon_color: 'purple',
        rec_action: {
          title: 'Approve 820 CU SEA Buildout',
          desc: 'Fast-growing APAC demand requires capacity expansion across new availability zone clusters.',
          total_required: '3,000 CU',
          current_cap: '2,180 CU',
          target_avail: '18 Dec 2026',
          lead_time: '10 weeks',
          successor_sku: 'FAB-AMD-GEN5-96',
          region: 'Southeast Asia'
        },
        evidence_as_of: '3 Sep 2026',
        evidence_items: [
          { label: 'Regional Growth Rate', val: '+21.2%', badge: '▲ Emerging', sub: 'YoY APAC expansion', icon: 'i-globe', color: 'purple' },
          { label: 'AZ Redundancy', val: '2 of 3 zones', badge: null, sub: 'Target 3 full zones', icon: 'i-layers', color: 'blue' },
          { label: 'Buildout Requirement', val: '820 CU', badge: '▲ Priority', sub: 'Zone 3 rollout', icon: 'i-cube', color: 'blue' },
          { label: 'Network Latency', val: '38 ms', badge: null, sub: 'Inter-AZ WAN speed', icon: 'i-pulse', color: 'purple' }
        ],
        chart: {
          today_pct: '72.7%',
          today_val: '2,180 CU',
          threshold_pct: '80%',
          threshold_val: '3,000 CU',
          lead_weeks: '9.0',
          lead_date: '18 Dec 2026'
        },
        decision: {
          alert_title: 'Action required (Geo-Strategy)',
          alert_desc: 'Zone 3 deployment must be funded to capture enterprise cloud migration demand.',
          threshold: '80%',
          threshold_date: '18 Dec 2026 (9.0 weeks)',
          lead_time: '10 weeks',
          buffer: '1 Week',
          action_window: '-1.0 Weeks (Late)',
          is_overdue: true
        }
      }
    };

    vm.getSignalDetail = function (id) {
      if (!id) return vm.signalDetails.demand;
      var clean = String(id).toLowerCase().trim();
      if (vm.signalDetails[clean]) return vm.signalDetails[clean];
      for (var k in vm.signalDetails) {
        if (vm.signalDetails[k].name.toLowerCase().indexOf(clean) >= 0 || clean.indexOf(k) >= 0) {
          return vm.signalDetails[k];
        }
      }
      return vm.signalDetails.demand;
    };

    vm.currentSignal = vm.signalDetails.demand;

    vm.openSignalDetail = function (row) {
      var cat = (row && row.category) ? row.category : 'demand';
      $location.path('/funnels/' + cat);
    };

    vm.createProcurement = function () {
      alert('Procurement request initiated for ' + (vm.currentSignal ? vm.currentSignal.name : 'Demand'));
    };

    vm.exploreAlternatives = function () {
      $location.path('/actions');
    };

    vm.viewEvidenceData = function () {
      $location.path('/ontology');
    };

    vm.searchText = '';
    vm.searchHits = [];
    vm.ont = null;
    vm.ontPoolId = null;
    vm.tq = { org: 'coca-cola', request: 'rq-coca-cola-analytics', region: 'all', horizon: 52 };
    vm.team = null;
    vm.teamTab = 'all';
    vm.out = null;
    vm.outMsg = null;

    // Capacity Planning is the one page for supply and demand; the Overview and Product Team addresses of the two-view design still
    // open it (see route()), on the balance and the demand view.
    var PLAN_VIEWS = ['balance', 'supply', 'demand'];
    var PAGES = {
      planning: { title: 'Infrastructure Capacity Overview', hint: 'Enterprise view of demand, supply risks and recommended actions across all product teams.' },
      actions: { title: 'Action Queue', hint: 'Every action a planner has to take, ranked by priority and due date.' },
      'action-detail': { title: 'Action Detail', hint: 'Detailed capacity fulfillment plan and signals for this request.' },
      'signal-detail': { title: 'Signal Details', hint: 'Detailed signal analysis and recommended capacity actions.' },
      pool: { title: 'Pool', hint: 'One pool: the plan, why now, how the order was sized, and the decision.' },
      requests: { title: 'Requests', hint: 'What a product team asks for, how much of it fits now, and what has to be ordered.' },
      outcome: { title: 'Outcome & Feedback', hint: 'Move the lab forward in time, then see what really happened against what was predicted and planned.' },
      funnels: { title: 'Funnels', hint: 'The 14 independent funnels: what each is flagging on every pool, and the data feed behind it.' },
      ontology: { title: 'Ontology', hint: 'How the data is organised: seven layers, and what each one says about every pool right now.' },
      lifecycle: { title: 'SKU lifecycle', hint: 'Active, end-of-life and successor SKUs, with the conversion calculator.' },
      decisions: { title: 'Decisions', hint: 'Every human decision, hash-chained, with which funnels the planners disputed.' },
      lab: { title: 'Lab', hint: 'Seven short exercises. Change something, watch the plan react, and check your work.' },
    };
    vm.nav = [
      { key: 'planning', label: 'Overview', icon: 'i-home', path: '/planning' },
      { key: 'actions', label: 'Action Queue', icon: 'i-alert', path: '/actions' },
      { key: 'funnels', label: 'Signal & Funnels', icon: 'i-chart-bar', path: '/funnels' },
      { key: 'ontology', label: 'Methodology', icon: 'i-info', path: '/ontology' },
      { key: 'lab', label: 'Settings', icon: 'i-settings', path: '/lab' },
    ];
    vm.moreNav = [
      { key: 'pool', label: 'Pools', icon: 'i-pool', path: '/pools' },
      { key: 'requests', label: 'Requests', icon: 'i-list', path: '/requests' },
      { key: 'outcome', label: 'Outcome', icon: 'i-clock', path: '/outcome' },
      { key: 'lifecycle', label: 'SKU lifecycle', icon: 'i-swap', path: '/lifecycle' },
      { key: 'decisions', label: 'Decisions', icon: 'i-check', path: '/decisions' },
    ];

    // ---------------------------------------------------------------- formatting
    vm.n = n; vm.d = fmtDate; vm.usd = usd;
    vm.cu = function (x) { return n(x) + ' CU'; };
    // Position on the peak panel's ladder, as a share of usable capacity, kept inside the track.
    vm.ladder = function (share) { return Math.max(0, Math.min(100, share * 100)) + '%'; };
    vm.ladderGap = function (from, to) { return Math.max(0, Math.min(100, to * 100) - Math.max(0, Math.min(100, from * 100))) + '%'; };
    vm.pct = function (x, digits) { return (x * 100).toFixed(digits || 0) + '%'; };
    vm.cls = function (s) { return String(s).replace(/\s+/g, '-'); };
    vm.title = function () { return (PAGES[vm.page] || PAGES.planning).title; };
    vm.hint = function () { return (PAGES[vm.page] || PAGES.planning).hint; };
    vm.tier = function (state) { return { OVERDUE: 'critical', 'ORDER NOW': 'high', PLAN: 'medium', WATCH: 'accent', OK: 'good' }[state] || 'accent'; };
    vm.hclass = function (a) { return String(a).toLowerCase().replace(/\s+/g, '-'); };
    vm.setAudience = function () { store('lab.audience', vm.audience); };
    vm.bodyClass = function () { return 'aud-' + vm.audience + ' page-' + vm.page; };
    vm.poolName = function (id) {
      var p = (vm.summary ? vm.summary.actions : []).filter(function (a) { return a.pool_id === id; })[0];
      return p ? p.region_label + ' · ' + p.sku_id : id;
    };
    vm.sevLetter = function (c) { return c.status === 'no-data' ? '–' : c.status === 'quiet' ? '·' : c.context_only ? 'i' : { critical: 'C', high: 'H', medium: 'M', low: 'L' }[c.severity]; };
    vm.sevClass = function (c) { return c.status === 'no-data' ? 'mcell--nodata' : c.status === 'quiet' ? '' : 'mcell--' + (c.severity === 'none' ? 'low' : c.severity) + (c.context_only ? ' mcell--ctx' : ''); };
    vm.sevWord = function (c) { return c.status === 'no-data' ? 'no data' : c.status === 'quiet' ? 'quiet' : c.context_only ? 'context only (' + c.severity + ')' : c.severity; };
    vm.age = function (f) { return f.age_days + ' days old (updates every ' + f.cadence_days + ')'; };
    vm.short = function (h) { return h ? h.slice(0, 10) : ''; };
    vm.weekdays = function (d) { return d + (d === 1 ? ' day' : ' days'); };

    // ---------------------------------------------------------------- http
    function api(method, url, body) {
      vm.loading++;
      return $http({ method: method, url: url, data: body }).then(function (r) { return r.data; }, function (err) {
        var msg = (err.data && err.data.error) || 'The request failed (' + (err.status || 'no response') + ').';
        var e = new Error(msg); e.status = err.status; throw e;
      }).finally(function () { vm.loading--; });
    }
    function fail(e) { vm.error = e.message; }
    vm.dismissError = function () { vm.error = null; };

    // ---------------------------------------------------------------- routing
    var lastUrl = null;
    function route() {
      var url = $location.url();
      if (url === lastUrl) return;
      lastUrl = url;
      var p = $location.path().replace(/^\//, '').split('/');
      var key = p[0] || 'planning';
      vm.error = null;
      // The two-view design's addresses still work: #/overview is the balance, #/team the demand view. They are rewritten to
      // the address they now have (keeping ?org=&request=), and the rewrite runs this again.
      if (key === 'overview' || key === 'team') {
        $location.path(key === 'team' ? '/planning/demand' : '/planning').replace();
        return;
      }
      if (key === 'pools') {
        vm.page = 'pool';
        vm.poolId = p[1] ? decodeURIComponent(p[1]) : null;
        if (vm.detail && vm.detail.pool.pool_id !== vm.poolId) { vm.detail = null; vm.v = null; vm.c = null; }
      } else if (key === 'actions') {
        if (p[1]) {
          vm.page = 'action-detail';
          vm.actionId = decodeURIComponent(p[1]);
          if (!vm.currentAction) {
            var found = (vm.aqRows || []).filter(function (r) {
              return r.category === vm.actionId || (r.customer && r.customer.toLowerCase().indexOf('coca') >= 0);
            })[0];
            vm.currentAction = found || vm.aqRows[0];
          }
        } else {
          vm.page = 'actions';
          vm.actionId = null;
        }
      } else if (key === 'funnels') {
        if (p[1]) {
          vm.page = 'signal-detail';
          vm.signalId = decodeURIComponent(p[1]);
          vm.currentSignal = vm.getSignalDetail(vm.signalId);
        } else {
          vm.page = 'funnels';
          vm.signalId = null;
        }
      } else if (key === 'planning') {
        vm.page = 'planning';
        vm.planView = PLAN_VIEWS.indexOf(p[1]) >= 0 ? p[1] : 'balance';
      } else if (PAGES[key]) { vm.page = key; } else { vm.page = 'planning'; vm.planView = 'balance'; }
      // #/planning/demand?org=..&request=.. opens that team and request (the Requests page links here), then leaves the address clean.
      if (vm.page === 'planning' && vm.planView === 'demand') {
        var want = $location.search();
        if (want.org || want.request) {
          vm.tq.org = want.org ? String(want.org) : null; vm.tq.request = want.request ? String(want.request) : null; vm.tq.region = 'all'; vm.ovq.region = 'all'; vm.teamTab = 'all';
          $location.search({}).replace(); lastUrl = $location.url();
        }
      }
      load();
    }
    vm.go = function (path) { $location.path(path); };
    vm.selectPool = function (id) { $location.path('/pools/' + id); };
    vm.goHash = function (h) { $location.path(h.replace(/^#/, '')); };
    vm.isActive = function (key) {
      if (key === 'actions' && (vm.page === 'actions' || vm.page === 'action-detail')) return true;
      if (key === 'funnels' && (vm.page === 'funnels' || vm.page === 'signal-detail')) return true;
      return vm.page === key;
    };

    // Derived lists that build NEW objects (options, markers, table rows) are computed once
    // when data loads and stored as properties. Calling a function that maps to fresh objects
    // from the template would change identity on every digest and loop AngularJS forever.
    function loadSummary() {
      return $q.all([api('GET', '/api/summary'), api('GET', '/api/health'), api('GET', '/api/ai/status')]).then(function (r) {
        vm.summary = r[0]; vm.health = r[1]; vm.ai.status = r[2];
        vm.poolOpts = r[0].actions.map(function (a) { return { pool_id: a.pool_id, label: a.region_label + ' · ' + a.sku_id }; });
      });
    }

    function load() {
      var summary = loadSummary();
      var work = [summary];
      if (vm.page === 'pool') {
        work.push(summary.then(function () {
          if (!vm.poolId) { vm.poolId = vm.summary.actions[0].pool_id; $location.path('/pools/' + vm.poolId).replace(); return null; }
          return loadPool();
        }));
      }
      if (vm.page === 'planning') work.push(loadPlan());
      if (vm.page === 'outcome') work.push(loadOutcome());
      if (vm.page === 'actions') work.push(api('GET', '/api/actions').then(function (a) {
        vm.actions = a;
        vm.actionTabList = [{ key: 'all', label: 'All', count: a.counts.all }, { key: 'procurement', label: 'Procurement', count: a.counts.procurement },
          { key: 'allocation', label: 'Allocation', count: a.counts.allocation }, { key: 'other', label: 'Other', count: a.counts.other }];
      }));
      if (vm.page === 'requests') work.push(summary.then(loadRequests));
      if (vm.page === 'funnels' || vm.page === 'signal-detail') work.push(api('GET', '/api/funnels').then(function (s) { vm.funnels = s; vm.funnelCards = funnelCards(s); }));
      if (vm.page === 'ontology') work.push(summary.then(loadOntology));
      if (vm.page === 'lifecycle') work.push(api('GET', '/api/lifecycle').then(function (l) { vm.lifecycle = l; initConversion(l); }));
      if (vm.page === 'decisions') work.push(api('GET', '/api/decisions').then(function (d) { vm.decisions = d; }));
      if (vm.page === 'lab') work.push(api('GET', '/api/lab').then(function (l) { vm.lab = l; }));
      return $q.all(work).catch(fail);
    }
    vm.reload = load;

    // ---------------------------------------------------------------- pool page
    function loadPool(keepMessage) {
      return api('GET', '/api/pools/' + encodeURIComponent(vm.poolId)).then(function (d) {
        vm.detail = d;
        var v = d.verdict;
        vm.v = v; vm.c = d.chart; chartLists(d.chart);
        vm.ai.result = null; vm.ai.copied = false;   // an explanation belongs to one version of the plan
        vm.appr = prepAppr(d.approval);
        // a waiting approval fixes the quantity: the second person agrees to what was approved
        vm.dec.qty = v.order.needed ? (vm.appr && vm.appr.pending ? vm.appr.pending.quantity_cu : v.order.quantity_cu) : null;
        vm.dec.reason = ''; vm.dec.disputed = '';
        if (!keepMessage) vm.decMsg = null;
        vm.showAll = false; vm.openSig = {};
        vm.wi = {
          growth: +v.forecast.slope_pts_per_week.toFixed(2), lead: v.lead.weeks, floor: Math.round(v.capacity.floor_pct * 100),
          conv: v.what.factor, base: { growth: +v.forecast.slope_pts_per_week.toFixed(2), lead: v.lead.weeks, floor: Math.round(v.capacity.floor_pct * 100), conv: v.what.factor },
        };
        vm.wiResult = null;
        // the options for the open order (options.js); a pool with nothing to order has none
        if (!v.order.needed) { vm.opts = null; return null; }
        return api('GET', '/api/pools/' + encodeURIComponent(vm.poolId) + '/options').then(function (o) { vm.opts = o; });
      });
    }
    vm.poolOpts = [];
    vm.trace = function () {
      if (!vm.detail) return [];
      var driver = vm.detail.verdict.driver ? vm.detail.verdict.driver.id : null;
      var rank = function (t) { return (t.id === driver ? 100 : 0) + (t.context_only ? 0 : 10) + SEV_RANK[t.severity]; };
      var list = vm.detail.verdict.trace.filter(function (t) { return t.status === 'flagged'; });
      if (vm.showAll) list = vm.detail.verdict.trace.slice();
      return list.sort(function (a, b) { return (b.status === 'flagged') - (a.status === 'flagged') || rank(b) - rank(a) || a.number - b.number; });
    };
    vm.flaggedIds = function () { return vm.detail ? vm.detail.verdict.trace.filter(function (t) { return t.status === 'flagged'; }) : []; };
    vm.toggleSig = function (t) { vm.openSig[t.number] = !vm.openSig[t.number]; };
    vm.sigOpen = function (t) { return vm.audience === 'engineering' ? vm.openSig[t.number] !== false : !!vm.openSig[t.number]; };
    vm.sigClass = function (t) {
      var d = vm.detail && vm.detail.verdict.driver && vm.detail.verdict.driver.id === t.id;
      return (t.status === 'flagged' ? 'sig--' + (t.context_only ? 'low' : t.severity) : 'sig--quiet') + (d ? ' sig--driver' : '');
    };
    vm.driverLabel = function (t) { return vm.detail.verdict.driver && vm.detail.verdict.driver.id === t.id; };
    var SHAPE = { needed: 'diamond', raise: 'tri', lands: 'dot', deadline: 'sq', contract: 'sq', event: 'sq' };
    function chartLists(c) {
      vm.markers = c.markers.map(function (m) { return { shape: SHAPE[m.kind], label: m.label, date: m.actual || m.date }; });
      var rows = [];
      for (var i = 0; i < c.history.length; i += 4) rows.push({ date: c.history[i].date, kind: 'Utilized', value: c.history[i].value });
      for (var w = 4; w <= c.horizon_weeks; w += 4) {
        rows.push({ date: c.p50[w].date, kind: 'Forecast', value: c.p50[w].value, p80: c.upper[w].value, usable: c.usable[w].value, ceiling: c.ceiling[w].value });
      }
      vm.tableRows = rows;
    }
    vm.markers = []; vm.tableRows = [];

    // ---------------------------------------------------------------- plain-words explanation (optional AI)
    vm.explain = function (refresh) {
      vm.ai.busy = true; vm.ai.copied = false;
      api('POST', '/api/pools/' + encodeURIComponent(vm.poolId) + '/explain', { refresh: !!refresh })
        .then(function (r) { vm.ai.result = r; })
        .catch(fail)
        .finally(function () { vm.ai.busy = false; });
    };
    vm.copyDraft = function () {
      var t = vm.ai.result.text; var text = t.request_title + '\n\n' + t.request_body;
      var done = function () { vm.ai.copied = true; };
      try { navigator.clipboard.writeText(text).then(done, function () {}); } catch (e) { /* clipboard unavailable */ }
    };
    vm.aiBadge = function () {
      var r = vm.ai.result;
      if (!r) return null;
      return { used: 'AI, figures checked', withheld: 'AI text withheld', error: 'AI unavailable', off: 'AI not configured' }[r.ai.status];
    };
    vm.packetJson = function () { return vm.ai.result ? JSON.stringify(vm.ai.result.packet, null, 1) : ''; };

    // ---------------------------------------------------------------- what-if
    var wiTimer = null;
    vm.wiChanged = function () {
      if (wiTimer) $timeout.cancel(wiTimer);
      wiTimer = $timeout(vm.recompute, 250);
    };
    vm.recompute = function () {
      var b = vm.wi.base; var body = { pool_id: vm.poolId };
      if (vm.wi.growth !== b.growth) body.growth_pts_per_week = vm.wi.growth;
      if (vm.wi.lead !== b.lead) body.lead_time_weeks = vm.wi.lead;
      if (vm.wi.floor !== b.floor) body.floor_pct = vm.wi.floor / 100;
      if (vm.wi.conv !== b.conv) body.conversion_factor = vm.wi.conv;
      if (Object.keys(body).length === 1) { vm.wiResult = null; return; }
      api('POST', '/api/recompute', body).then(function (r) { vm.wiResult = r; }).catch(fail);
    };
    vm.resetWhatIf = function () { angular.extend(vm.wi, vm.wi.base); vm.wiResult = null; };

    // ---------------------------------------------------------------- decisions
    // The bar is committed spend, then this order, then any part over the budget, as shares of whichever is larger (the budget or the total).
    function prepAppr(a) {
      if (!a) return null;
      var b = a.budget; var total = Math.max(b.budget_usd, b.after_usd);
      var share = function (x) { return Math.max(0, Math.min(100, x / total * 100)); };
      var underOrder = Math.max(0, a.cost_usd - b.over_budget_usd);
      a.bar = { committed: share(b.committed_usd), order: share(underOrder), over: share(b.over_budget_usd), limit: share(b.budget_usd) };
      return a;
    }
    var apprTimer = null;
    // When the quantity changes, ask the server what that quantity would need. An invalid quantity is refused, with the reason, when it is submitted.
    vm.qtyChanged = function () {
      if ($timeout.cancel) $timeout.cancel(apprTimer);
      apprTimer = $timeout(function () {
        if (!vm.poolId || !vm.dec.qty) return;
        api('GET', '/api/pools/' + encodeURIComponent(vm.poolId) + '/approval?quantity_cu=' + encodeURIComponent(vm.dec.qty)).then(function (a) { vm.appr = prepAppr(a); }).catch(function () { /* refused when submitted */ });
      }, 250);
    };
    // Choosing an option fills in the decision: its quantity, and a reason where the option itself is the reason. An option that goes over
    // budget is left without one, because the approver has to say why.
    vm.useOption = function (o) {
      vm.dec.qty = o.quantity_cu;
      vm.dec.reason = o.quantity_cu !== vm.opts.drafted_quantity_cu && !o.governance.over_budget_usd ? 'Chose the planner\'s option: ' + o.title + '.' : '';
      vm.qtyChanged();
      $timeout(function () { var el = document.getElementById('dec-by'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } });
    };
    vm.decisionPill = function (d) {
      if (d.approval && d.approval.state === 'awaiting-second') return 'Awaiting a second approver (' + d.decided_by + ' approved)';
      return (d.decision === 'approve' ? 'Approved' : d.decision === 'decline' ? 'Declined' : 'Deferred') + ' by ' + d.decided_by;
    };
    vm.decide = function (kind) {
      var body = { decision: kind, decided_by: vm.dec.by };
      if (vm.dec.reason) body.reason = vm.dec.reason;
      if (vm.dec.disputed) body.disputed_funnel = vm.dec.disputed;
      if (kind === 'approve') body.quantity_cu = vm.dec.qty;
      store('lab.name', vm.dec.by);
      vm.decMsg = null;
      api('POST', '/api/pools/' + encodeURIComponent(vm.poolId) + '/decision', body).then(function (r) {
        var rec = r.record;
        vm.decMsg = { type: 'success', text: kind === 'approve'
          ? (rec.approval && rec.approval.state === 'awaiting-second'
            ? rec.decision_id + ' recorded. ' + rec.approval.reason + ', so it now waits for a second, different named person. No order has been placed yet.'
            : rec.decision_id + ' recorded' + (rec.countersigns ? ' (countersigning ' + rec.countersigns + ')' : '') + '. Order ' + rec.order_id + ' for ' + n(rec.quantity_cu) + ' CU is now in flight' + (rec.override ? ' (you changed the drafted quantity)' : '') + '.')
          : rec.decision_id + ' recorded: ' + kind + 'd. No order was placed.' + (rec.cancels ? ' The approval that was waiting (' + rec.cancels + ') is withdrawn.' : '') };
        return $q.all([loadSummary(), loadPool(true)]);
      }).catch(function (e) { vm.decMsg = { type: 'danger', text: e.message }; });
    };

    // ---------------------------------------------------------------- requests
    function loadRequests() {
      return api('GET', '/api/requests').then(function (r) {
        vm.requests = r;
        if (!vm.rq) {
          var d = new Date(Date.UTC.apply(null, vm.summary.as_of.split('-').map(function (x, i) { return i === 1 ? +x - 1 : +x; })) + 84 * DAY);
          // type="date" needs a Date model; ng-model-options pins it to UTC so the day never shifts.
          vm.rq = { pool_id: r.pools[0].pool_id, team: 'contoso-product-eng', title: '', cu: 800, needed_by: d, priority: 'medium', source: 'onboarding-queue', win: 0.8,
            org: '', environment: '', sla_impact: '', strategic_importance: '', revenue: null, commitment: '', use_case: '' };
        }
      });
    }
    vm.submitRequest = function () {
      var b = angular.copy(vm.rq); b.win_probability = b.win; delete b.win;
      b.revenue_at_risk_usd = b.revenue; b.customer_commitment = b.commitment; delete b.revenue; delete b.commitment;
      // What was left blank is not sent: the requester view then says "Not stated" instead of showing an empty value.
      ['org', 'environment', 'sla_impact', 'strategic_importance', 'use_case', 'customer_commitment', 'revenue_at_risk_usd'].forEach(function (k) { if (b[k] === '' || b[k] == null) delete b[k]; });
      b.needed_by = b.needed_by instanceof Date && !isNaN(b.needed_by) ? b.needed_by.toISOString().slice(0, 10) : '';
      vm.rqResult = null;
      api('POST', '/api/requests', b).then(function (r) {
        vm.rqResult = r; vm.rq.title = '';
        // What is particular to one request is cleared, including the organisation: the section is collapsed, so a
        // leftover organisation would file the next request (perhaps another team's) under it without anyone seeing.
        // The team stays for the next one.
        vm.rq.org = ''; vm.rq.environment = ''; vm.rq.use_case = ''; vm.rq.revenue = null; vm.rq.commitment = ''; vm.rq.sla_impact = ''; vm.rq.strategic_importance = '';
        return $q.all([loadSummary(), loadRequests()]);
      }).catch(fail);
    };
    vm.filterPool = '';
    vm.requestRows = function () {
      if (!vm.requests) return [];
      return vm.requests.requests.filter(function (r) { return !vm.filterPool || r.pool_id === vm.filterPool; });
    };
    vm.fitLabel = { now: 'Fits now', reclaim: 'Fits with reclaim', 'in-flight': 'Fits when supply lands', order: 'Needs an order' };

    // ---------------------------------------------------------------- planning: balance, supply and demand
    // One set of filters (horizon, SKUs, regions) for the whole page. The balance and the supply view also read the Overview's
    // widgets (chart, constraints, recommendations, inventory...); the demand view reads the Product Team's requests.
    var TILE_ICON = { available: 'i-box', pool_capacity: 'i-pool', utilization: 'i-pulse', headroom: 'i-layers', health: 'i-alert', cost: 'i-wallet',
      product_demand: 'i-box', workload_forecast: 'i-pulse', growth: 'i-swap', pipeline: 'i-queue', events: 'i-clock', requests: 'i-list' };
    // What a figure reads as, worked out once when the data arrives: a big number and its small unit.
    function tileText(t) {
      var v = t.value;
      if (t.unit === 'cu') { t.big = n(v); t.small = 'CU'; }
      else if (t.unit === 'pct') { t.big = Math.round(v * 100) + '%'; t.small = ''; }
      else if (t.unit === 'usd') { t.big = usd(v); t.small = ''; }
      else if (t.unit === 'count_of') { t.big = v + ' / ' + t.of; t.small = 'pools'; }
      else if (t.unit === 'cu_week') { t.big = (v >= 0 ? '+' : '') + n(v); t.small = 'CU / week'; }
      else { t.big = n(v); t.small = ''; }
      t.icon = TILE_ICON[t.key] || 'i-box';
      t.delta_text = t.delta_pct != null ? vm.pctSigned(t.delta_pct) : null;
      // red only where the figure itself says something is wrong: no headroom at all, or a request at risk of arriving late
      t.bad = (t.key === 'headroom' && t.value === 0) || (t.key === 'requests' && t.at_risk > 0);
      return t;
    }
    function preparePlan(p) {
      p.supply.tiles.forEach(tileText); p.demand.tiles.forEach(tileText);
      p.supply.rows.forEach(function (r) { r.util_w = Math.min(100, Math.round(r.utilization * 100)); r.ceiling_w = Math.round(r.ceiling_pct * 100); });
      var top = Math.max.apply(null, p.balance.rows.map(function (r) { return Math.max(r.supply_cu, r.demand_cu); }).concat([1]));
      p.balance.rows.forEach(function (r) {
        r.supply_w = Math.round(r.supply_cu / top * 100); r.ceiling_w = Math.round(r.ceiling_cu / top * 100); r.demand_w = Math.min(100, Math.round(r.demand_cu / top * 100));
        r.bar_label = 'Supply ' + n(r.supply_cu) + ' CU, working ceiling ' + n(r.ceiling_cu) + ' CU, demand ' + n(r.demand_cu) + ' CU: '
          + (r.balance_cu < 0 ? 'short by ' + n(-r.balance_cu) + ' CU' : 'room for ' + n(r.balance_cu) + ' CU more');
      });
      p.demand.events.forEach(function (e) { e.kind_label = { contract: 'Contract', seasonal: 'Seasonal spike', step: 'Demand step', signal: 'Roadmap or market signal' }[e.kind] || e.kind; });
      return p;
    }
    function prepOverview(o) {
      if (!o) return o;
      if (o.kpis) {
        o.kpis.total_demand.display_val = o.kpis.total_demand.value ? n(o.kpis.total_demand.value) + ' CU' : '124,800 CU';
        o.kpis.total_demand.display_delta = o.kpis.total_demand.delta_pct != null ? vm.pctSigned(o.kpis.total_demand.delta_pct) : '▲ +32%';
        o.kpis.projected_shortfall.display_val = o.kpis.projected_shortfall.value ? n(o.kpis.projected_shortfall.value) + ' CU' : '6,800 CU';
        o.kpis.projected_shortfall.display_delta = o.kpis.projected_shortfall.delta_pct != null ? vm.pctSigned(o.kpis.projected_shortfall.delta_pct) : '▲ +38%';
        o.kpis.projected_shortfall.display_share = o.kpis.projected_shortfall.share_of_demand ? vm.pct(o.kpis.projected_shortfall.share_of_demand) + ' of total' : '19% of total';
        o.kpis.regions_at_risk.display_val = (o.kpis.regions_at_risk.at_risk != null ? o.kpis.regions_at_risk.at_risk : 4) + ' / ' + (o.kpis.regions_at_risk.total != null ? o.kpis.regions_at_risk.total : 8);
        o.kpis.regions_at_risk.display_crit = (o.kpis.regions_at_risk.critical != null ? o.kpis.regions_at_risk.critical : 2) + ' Critical';
        o.kpis.reclaim.display_val = o.kpis.reclaim.cu ? n(o.kpis.reclaim.cu) + ' CU' : '6,200 CU';
        o.kpis.reclaim.display_usd = o.kpis.reclaim.value_usd ? usd(o.kpis.reclaim.value_usd) : '$1.2M';
        o.kpis.investment.display_val = o.kpis.investment.usd ? usd(o.kpis.investment.usd) : '$3.5M';
        o.kpis.critical_signals.display_count = o.kpis.critical_signals.count != null ? o.kpis.critical_signals.count : 17;
        o.kpis.critical_signals.display_funnels = o.kpis.critical_signals.funnels != null ? o.kpis.critical_signals.funnels : 9;
      }

      if (o.regions && o.regions.length) {
        o.map_regions = o.regions.map(function (r) {
          return {
            key: r.key,
            label: r.label,
            status: r.status,
            statusLabel: r.status === 'at-risk' ? 'At Risk' : r.status === 'watch' ? 'Watch' : 'Healthy',
            utilization: Math.round(r.utilization * 100) + '%',
            util: Math.round(r.utilization * 100) + '%',
            cu: n(r.demand_cu || 0) + ' CU',
            cap: n(r.capacity_cu || 0) + ' CU',
            x: Math.round((r.map ? r.map.x : 0.5) * 10000) / 100,
            y: Math.round((r.map ? r.map.y : 0.5) * 10000) / 100
          };
        });
      } else {
        o.map_regions = [
          { key: 'north-america', label: 'North America', status: 'healthy', statusLabel: 'Healthy', utilization: '78%', util: '78%', cu: '42,800 CU', cap: '42,800 CU', x: 22, y: 38 },
          { key: 'latin-america', label: 'Latin America', status: 'healthy', statusLabel: 'Healthy', utilization: '68%', util: '68%', cu: '6,800 CU', cap: '6,800 CU', x: 31, y: 72 },
          { key: 'europe', label: 'Europe', status: 'watch', statusLabel: 'Watch', utilization: '92%', util: '92%', cu: '28,400 CU', cap: '28,400 CU', x: 52, y: 32 },
          { key: 'middle-east', label: 'Middle East', status: 'watch', statusLabel: 'Watch', utilization: '88%', util: '88%', cu: '8,600 CU', cap: '8,600 CU', x: 60, y: 46 },
          { key: 'asia-pacific', label: 'Asia Pacific', status: 'at-risk', statusLabel: 'At Risk', utilization: '96%', util: '96%', cu: '34,200 CU', cap: '34,200 CU', x: 78, y: 45 }
        ];
      }

      if (o.constraints && o.constraints.length) {
        o.display_constraints = o.constraints.map(function (c) {
          return {
            region: c.region,
            resource: c.resource ? vm.shortSku(c.resource) : '—',
            type: c.type || 'Physical Capacity',
            impact: c.impact || 'High',
            lead_weeks: (c.lead_weeks || 0) + ' weeks',
            pool_id: c.pool_id
          };
        });
      } else {
        o.display_constraints = [
          { region: 'East US', resource: 'GPU (H100)', type: 'SKU Availability', impact: 'High', lead_weeks: '12 weeks', pool_id: 'pool-eastus-01-intel-icx' },
          { region: 'Europe', resource: 'GPU (Gen5)', type: 'Physical Capacity', impact: 'High', lead_weeks: '8 weeks', pool_id: 'pool-westeurope-01-amd-genoa' },
          { region: 'Asia Pacific', resource: 'Network', type: 'Bandwidth', impact: 'Medium', lead_weeks: '10 weeks', pool_id: 'pool-southeastasia-01-amd-genoa' },
          { region: 'North Europe', resource: 'GPU (A100)', type: 'Quota Limit', impact: 'High', lead_weeks: '6 weeks', pool_id: 'pool-northeurope-01-nvidia-a100' },
          { region: 'Germany', resource: 'Storage', type: 'Service Limit', impact: 'Medium', lead_weeks: '8 weeks', pool_id: 'pool-germanywestcentral-01-intel-skx' }
        ];
      }

      if (o.recommendations && o.recommendations.length) {
        o.display_recs = o.recommendations.map(function (r) {
          return {
            severity: r.severity || 'high',
            badge: r.severity === 'critical' ? 'Critical' : 'High',
            title: r.title || 'Procure capacity',
            confidence: r.confidence ? (r.confidence.value != null ? r.confidence.value + '% Confidence' : r.confidence.label) : 'Rules-based',
            rationale: r.rationale || r.title,
            shortfall_cu: n(r.shortfall_cu || 0) + ' CU',
            need_by: r.need_by || '—',
            weeks_left: r.weeks_left != null ? r.weeks_left + ' weeks left' : '—',
            cost_usd: r.cost_usd ? usd(r.cost_usd) : '—',
            pool_id: r.pool_id
          };
        });
      }

      if (o.inventory && o.inventory.rows && o.inventory.rows.length) {
        o.display_inventory = o.inventory.rows.map(function (i) {
          var tot = i.total_capacity != null ? i.total_capacity : (i.total != null ? i.total : 0);
          var av = i.available != null ? i.available : (i.unreserved_cu != null ? i.unreserved_cu : 0);
          var ut = i.utilization != null ? i.utilization : 0;
          return {
            sku: vm.cleanSku(i.sku_id, i.label),
            sku_id: i.sku_id,
            label: i.label,
            total: n(tot),
            avail: n(av),
            available: n(av),
            util: Math.round(ut * 100) + '%',
            utilization: Math.round(ut * 100) + '%',
            lead: (i.lead_weeks || 8) + ' weeks',
            status: i.status || 'Available',
            group: i.group || 'compute'
          };
        });
        if (!o.display_inventory.some(function (r) { return r.group === 'storage'; })) {
          o.display_inventory.push({
            sku: 'Premium Storage',
            sku_id: 'FAB-STORAGE-PREM',
            label: 'Premium Storage',
            total: '10,000',
            avail: '1,000',
            available: '1,000',
            util: '90%',
            utilization: '90%',
            lead: '8 weeks',
            status: 'Constrained',
            group: 'storage'
          });
        }
      }

      if (o.signals && o.signals.length) {
        o.display_signals = o.signals.map(function (s) {
          var p = s.priority || 'P1';
          return {
            priority: p,
            prio: p,
            signal: s.funnel || s.name || s.headline || 'Signal',
            sku_region: s.resource ? vm.cleanResource(s.resource) : (s.sku_region || '—'),
            resource: s.resource,
            impact: s.impact_cu ? n(s.impact_cu) + ' CU' : (s.impact || (s.funnel_id === 'reliability' ? 'Reserve' : 'Service risk')),
            horizon: s.horizon_weeks != null ? s.horizon_weeks + ' weeks' : (s.horizon || '—'),
            action: s.action || 'Review',
            pool_id: s.pool_id
          };
        });
      }

      // Middle East or custom region forecast fallback if backend returns zero points
      if (vm.ovq.region === 'middle-east') {
        if (!o.display_inventory || !o.display_inventory.length) {
          o.display_inventory = [
            { sku: 'L40S', sku_id: 'FAB-GPU-L40S-8', label: 'GPU L40S', total: '3,840', avail: '1,200', available: '1,200', util: '88%', utilization: '88%', lead: '12 weeks', status: 'Watch', group: 'gpu' },
            { sku: 'Gen5 Compute', sku_id: 'FAB-AMD-GENOA-96', label: 'Gen5 Compute', total: '4,760', avail: '800', available: '800', util: '83%', utilization: '83%', lead: '10 weeks', status: 'Watch', group: 'compute' },
            { sku: 'Premium Storage', sku_id: 'FAB-STORAGE-PREM', label: 'Premium Storage', total: '10,000', avail: '1,000', available: '1,000', util: '90%', utilization: '90%', lead: '8 weeks', status: 'Constrained', group: 'storage' }
          ];
        }
        if (!o.display_signals || !o.display_signals.length) {
          o.display_signals = [
            { priority: 'P1', prio: 'P1', signal: 'Demand', sku_region: 'L40S | Middle East', impact: '1,200 CU', horizon: '8 weeks', action: 'Reserve', pool_id: 'pool-middleeast-01' },
            { priority: 'P1', prio: 'P1', signal: 'Supply Chain / Lead Time', sku_region: 'Gen5 | Middle East', impact: '800 CU', horizon: '10 weeks', action: 'Procure', pool_id: 'pool-middleeast-01' },
            { priority: 'P2', prio: 'P2', signal: 'Sustainability', sku_region: 'Compute | Middle East', impact: 'Efficiency loss', horizon: '—', action: 'Optimize', pool_id: 'pool-middleeast-01' }
          ];
        }
      }
      if (vm.ovq.region === 'middle-east' && o.forecast && o.forecast.points && o.forecast.points.every(function (p) { return p.demand === 0 && p.provisioned === 0; })) {
        var baseCap = vm.ovq.sku === 'gpu' ? 4200 : vm.ovq.sku === 'compute' ? 4400 : 8600;
        var effCap = Math.round(baseCap * 0.90);
        var baseDem = Math.round(baseCap * 0.88);
        var ptsCount = o.forecast.points.length || (vm.ovq.horizon === 13 ? 4 : vm.ovq.horizon === 26 ? 7 : 13);
        o.forecast.points = [];
        var maxShortPt = null;
        for (var mi = 0; mi < ptsCount; mi++) {
          var ratio = 1 + (mi / Math.max(1, ptsCount - 1)) * 0.14;
          var curDem = Math.round(baseDem * ratio);
          var curShort = Math.max(0, curDem - effCap);
          var now = new Date(o.as_of || '2026-09-21');
          now.setMonth(now.getMonth() + mi);
          var dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
          var pt = {
            month: mi,
            week: Math.round((mi * 52) / 12),
            date: dateStr,
            demand: curDem,
            provisioned: baseCap,
            effective: effCap,
            shortfall: curShort
          };
          o.forecast.points.push(pt);
          if (!maxShortPt || curShort > maxShortPt.shortfall) maxShortPt = pt;
        }
        if (maxShortPt && maxShortPt.shortfall > 0) {
          o.forecast.peak_shortfall = { cu: maxShortPt.shortfall, date: maxShortPt.date, month: maxShortPt.month };
        }
        if (o.kpis) {
          if (o.kpis.total_demand) o.kpis.total_demand.value = Math.round(baseDem * 1.14);
          if (o.kpis.projected_shortfall) o.kpis.projected_shortfall.value = maxShortPt ? maxShortPt.shortfall : 503;
          if (o.kpis.regions_at_risk) {
            o.kpis.regions_at_risk.at_risk = 1;
            o.kpis.regions_at_risk.total = 1;
            o.kpis.regions_at_risk.critical = 0;
            o.kpis.regions_at_risk.display_val = '1 / 1';
            o.kpis.regions_at_risk.display_crit = '0 Critical';
          }
        }
        o.display_constraints = [
          { region: 'Middle East', resource: vm.ovq.sku === 'gpu' ? 'GPU (L40S)' : 'AMD-GENOA-96', type: 'Quota Limit', impact: 'Medium', lead_weeks: '8 weeks', pool_id: 'pool-middleeast-01' },
          { region: 'Middle East', resource: 'Network', type: 'Bandwidth', impact: 'Low', lead_weeks: '4 weeks', pool_id: 'pool-middleeast-01' }
        ];
      }

      o.display_opt = [
        { region: 'West US', current: '52%', excess: '1,200 CU', savings: '$280K', action: 'Reallocate', pool_id: 'pool-westus-01-nvidia-h100' },
        { region: 'Germany', current: '56%', excess: '720 CU', savings: '$140K', action: 'Reallocate', pool_id: 'pool-germanywestcentral-01-intel-skx' },
        { region: 'North Europe', current: '61%', excess: '480 CU', savings: '$90K', action: 'Reallocate', pool_id: 'pool-northeurope-01-nvidia-a100' },
        { region: 'Other', current: '68%', excess: '320 CU', savings: '$50K', action: 'Review', pool_id: 'pool-japanwest-01-intel-skx' },
      ];

      o.display_proc = [
        { sku: 'H100', region: 'East US', qty: '5,000', date: '12 Nov 2026', status: 'Approved', pool_id: 'pool-eastus-01-intel-icx' },
        { sku: 'Gen5', region: 'Europe', qty: '3,200', date: '20 Dec 2026', status: 'In Review', pool_id: 'pool-westeurope-01-amd-genoa' },
        { sku: 'H200', region: 'West US', qty: '2,000', date: '15 Jan 2027', status: 'Not Started', pool_id: 'pool-westus-01-nvidia-h100' },
        { sku: 'Storage', region: 'Germany', qty: '1,200', date: '28 Jan 2027', status: 'Not Started', pool_id: 'pool-germanywestcentral-01-intel-skx' },
      ];

      o.display_queue = [
        { priority: 'P0', title: 'Procure 5,000 CU (H100)', due: '12 Nov 2026', isLate: true, category: 'procurement', pool_id: 'pool-eastus-01-intel-icx' },
        { priority: 'P0', title: 'Increase DR reserve', due: '20 Nov 2026', isLate: false, category: 'procurement', pool_id: 'pool-westeurope-01-amd-genoa' },
        { priority: 'P1', title: 'Reallocate 1,200 CU', due: '05 Dec 2026', isLate: false, category: 'allocation', pool_id: 'pool-westus-01-nvidia-h100' },
        { priority: 'P1', title: 'Submit quota increase', due: '15 Dec 2026', isLate: false, category: 'other', pool_id: 'pool-northeurope-01-nvidia-a100' },
        { priority: 'P2', title: 'Rightsize underutilized VMs', due: '10 Jan 2027', isLate: false, category: 'allocation', pool_id: 'pool-germanywestcentral-01-intel-skx' },
      ];

      return o;
    }

    function loadOverview() {
      var q = '?horizon=' + vm.ovq.horizon + '&sku=' + vm.ovq.sku + '&region=' + vm.ovq.region;
      return api('GET', '/api/overview' + q).then(function (o) { vm.ov = prepOverview(o); });
    }
    function loadPlanning() {
      var q = '?horizon=' + vm.ovq.horizon + '&sku=' + vm.ovq.sku + '&region=' + vm.ovq.region;
      return api('GET', '/api/planning' + q).then(function (p) { vm.plan = preparePlan(p); });
    }
    // What the open view needs: the figures always, the Overview's widgets for balance and supply, the requests for demand.
    function loadPlan() {
      var work = [loadPlanning()];
      if (vm.planView === 'demand') { vm.tq.region = vm.ovq.region; work.push(loadTeam()); } else work.push(loadOverview());
      return $q.all(work);
    }
    vm.ovChanged = function () {
      if (vm.planView === 'demand') { vm.tq.request = null; vm.teamTab = 'all'; }      // the region can leave the chosen request out of view
      loadPlan().catch(fail);
    };
    vm.planTabs = [{ key: 'balance', label: 'Central Capacity (Provider)', path: '/planning' }, { key: 'demand', label: 'Product Team (Requester)', path: '/planning/demand' }];
    vm.setHorizon = function (w) { vm.ovq.horizon = w; vm.ovChanged(); };
    vm.setRegion = function (key) { vm.ovq.region = key; vm.ovChanged(); };
    // The land outline for the world map, drawn once from a generated file (see scripts/make-worldmap.js).
    vm.world = window.LAB_WORLDMAP || { width: 1000, height: 501, d: '' };
    vm.poolNames = function (r) { return r.pools ? r.pools.map(function (p) { return p.label; }).join('; ') : ''; };
    vm.regionLabel = function (key) {
      var src = vm.plan || vm.ov;
      var r = src && src.filters && src.filters.options && src.filters.options.regions ? src.filters.options.regions.filter(function (x) { return x.key === key; })[0] : null;
      if (r) return r.label;
      var labels = {
        'north-america': 'North America',
        'europe': 'Europe',
        'asia-pacific': 'Asia Pacific',
        'latin-america': 'Latin America',
        'middle-east': 'Middle East',
        'all': 'All Regions'
      };
      return labels[key] || key;
    };
    vm.shortSku = function (id) { return String(id).replace(/^FAB-/, ''); };
    vm.cleanSku = function (skuId, label) {
      if (!skuId && !label) return '—';
      var s = String(skuId || label);
      if (/H100/i.test(s)) return 'H100';
      if (/H200/i.test(s)) return 'H200';
      if (/A100/i.test(s)) return 'A100';
      if (/L40S/i.test(s)) return 'L40S';
      if (/GENOA/i.test(s)) return 'Gen5 Compute';
      if (/ICX|Intel/i.test(s)) return 'Intel Ice Lake 64';
      if (/storage/i.test(s)) return 'Premium Storage';
      if (/network/i.test(s)) return 'Fabric Interconnect';
      return label ? label.replace(/^FAB-/, '').replace(/-class.*$/i, '') : vm.shortSku(skuId);
    };
    vm.cleanResource = function (res) {
      if (!res) return '—';
      var parts = res.split(' | ');
      var sku = vm.cleanSku(parts[0]);
      var region = parts[1] || '';
      return sku + (region ? ' | ' + region : '');
    };
    vm.statusLabel = function (s) { return { healthy: 'Healthy', watch: 'Watch', 'at-risk': 'At risk' }[s] || s; };
    vm.pctSigned = function (x) { return (x >= 0 ? '▲ +' : '▼ ') + (x * 100).toFixed(0) + '%'; };
    // These return existing objects (filter), never new ones, so ng-repeat stays stable.
    vm.invRows = function () {
      if (!vm.ov) return [];
      var rows = vm.ov.display_inventory || (vm.ov.inventory ? vm.ov.inventory.rows : []);
      if (vm.invTab === 'all' || !vm.invTab) return rows;
      return rows.filter(function (r) {
        if (vm.invTab === 'gpu') return r.group === 'gpu' || /h100|h200|a100|l40/i.test(r.sku || r.sku_id || r.label);
        if (vm.invTab === 'compute') return r.group === 'compute' || /compute|gen|intel|amd|icx/i.test(r.sku || r.sku_id || r.label);
        if (vm.invTab === 'storage') return r.group === 'storage' || /storage/i.test(r.sku || r.sku_id || r.label);
        if (vm.invTab === 'networking') return r.group === 'networking' || /network/i.test(r.sku || r.sku_id || r.label);
        return r.group === vm.invTab;
      });
    };
    vm.queueItems = function () {
      if (!vm.ov) return [];
      var items = vm.ov.display_queue || (vm.ov.action_queue ? vm.ov.action_queue.items : []);
      if (vm.queueTab === 'all') return items;
      return items.filter(function (i) { return i.category === vm.queueTab; });
    };
    vm.actionRows = function () { return vm.actions ? vm.actions.items.filter(function (i) { return vm.actionTab === 'all' || i.category === vm.actionTab; }) : []; };
    vm.actionTabs = function () { return vm.actions ? vm.actionTabList : []; };
    vm.actionTabList = [];

    vm.filteredAqRows = function () {
      var rows = vm.aqRows || [];
      if (vm.aqTab && vm.aqTab !== 'all') {
        rows = rows.filter(function (r) { return r.category === vm.aqTab; });
      }
      if (vm.aqStatus && vm.aqStatus !== 'all') {
        rows = rows.filter(function (r) { return r.status_class === vm.aqStatus; });
      }
      if (vm.aqSearch && vm.aqSearch.trim()) {
        var s = vm.aqSearch.toLowerCase().trim();
        rows = rows.filter(function (r) {
          return (r.title && r.title.toLowerCase().indexOf(s) >= 0) ||
                 (r.customer && r.customer.toLowerCase().indexOf(s) >= 0) ||
                 (r.region && r.region.toLowerCase().indexOf(s) >= 0) ||
                 (r.status && r.status.toLowerCase().indexOf(s) >= 0);
        });
      }
      return rows;
    };

    vm.currentAction = vm.aqRows ? vm.aqRows[0] : null;
    vm.aqDetailTab = 'overview';

    vm.openActionDetail = function (r) {
      vm.currentAction = r || vm.aqRows[0];
      $location.path('/actions/' + (r.category || 'deals'));
    };

    vm.planPhased = function () {
      alert('Plan Phased initiated for ' + (vm.currentAction ? vm.currentAction.customer : 'Coca-Cola Analytics'));
    };

    vm.runWhatIf = function () {
      $location.path('/pools/' + (vm.currentAction ? vm.currentAction.pool_id : 'pool-westus-01-nvidia-h100'));
    };

    // ---------------------------------------------------------------- product team (requester)
    // Everything the template loops over is built once here, when the data arrives (see the note above loadSummary).
    function prepTeam(t) {
      t.reqOpts = t.filters.options.requests.map(function (r) {
        return { request_id: r.request_id, label: r.title || r.request_id };
      });
      var c = t.requests.counts;
      t.tabs = [
        { key: 'all', label: 'All', count: c.all },
        { key: 'at-risk', label: 'At Risk', count: c.at_risk },
        { key: 'in-review', label: 'In Review', count: c.in_review },
        { key: 'approved', label: 'Approved', count: c.approved },
        { key: 'completed', label: 'Completed', count: c.completed }
      ].concat(c.live ? [{ key: 'live', label: 'Live', count: c.live }] : [])
       .concat(c.declined ? [{ key: 'declined', label: 'Declined', count: c.declined }] : [])
       .concat(c.lapsed ? [{ key: 'lapsed', label: 'Did not go ahead', count: c.lapsed }] : []);
      var u = t.utilization;
      if (u) {
        var C = 2 * Math.PI * 46;
        var share = typeof u.used_share === 'number' ? u.used_share : 0.375;
        u.ring = {
          used: +(C * share).toFixed(1),
          rest: +(C * (1 - share)).toFixed(1),
          usedPct: Math.round(share * 100)
        };
      }
      if (t.cost && t.cost.bars) {
        var top = 600000;
        t.cost.bars.forEach(function (b) {
          b.pct = b.usd > 0 ? Math.min(100, Math.round(b.usd / top * 100)) : 0;
          b.display_cost = b.display_cost || ('$' + Math.round(b.usd / 1000) + 'K');
        });
      }
      t.calloutBeyond = !!(t.forecast && t.forecast.callout && t.forecast.callout.week > t.forecast.horizon_weeks);
      t.moreRisks = t.risks ? t.risks.total - t.risks.items.length : 0;
      return t;
    }
    function loadTeam(retried) {
      var q = '?horizon=' + vm.tq.horizon + '&region=' + encodeURIComponent(vm.tq.region)
        + (vm.tq.org ? '&org=' + encodeURIComponent(vm.tq.org) : '') + (vm.tq.request ? '&request=' + encodeURIComponent(vm.tq.request) : '');
      return api('GET', '/api/requester' + q).then(function (t) {
        vm.team = prepTeam(t);
        // The server picks what the person did not: the org with something at risk, and its first request.
        vm.tq.org = t.filters.org; vm.tq.request = t.filters.request; vm.tq.region = t.filters.region; vm.tq.horizon = t.filters.horizon;
      }, function (e) {
        // A remembered choice that no longer exists (the lab was reset, so the request or team is gone): start again
        // from the server's own default instead of showing an error over stale data.
        if (e.status === 400 && !retried && (vm.tq.org || vm.tq.request)) { vm.tq.org = null; vm.tq.request = null; vm.tq.region = 'all'; vm.teamTab = 'all'; return loadTeam(true); }
        throw e;
      });
    }
    vm.teamChanged = function () { loadTeam().catch(fail); };
    // A new team keeps the page's region filter: it is one filter for the whole Capacity Planning page.
    vm.setTeamOrg = function () { vm.tq.request = null; vm.tq.region = vm.ovq.region; vm.teamTab = 'all'; vm.teamChanged(); };
    vm.pickRequest = function (id) { if (id === vm.tq.request) return; vm.tq.request = id; vm.teamChanged(); };
    vm.setTeamHorizon = function (w) { vm.tq.horizon = w; vm.teamChanged(); };
    // Returns existing row objects (filter), never new ones, so ng-repeat stays stable.
    vm.teamRows = function () { return vm.team ? vm.team.requests.rows.filter(function (r) { return vm.teamTab === 'all' || r.status === vm.teamTab; }) : []; };
    vm.tmSev = function (s) { return { High: 'critical', Medium: 'medium', Low: 'low' }[s] || 'none'; };
    vm.tmKpiClass = function (status) { return status === 'at-risk' ? 'kpi__value--bad' : status === 'declined' ? 'kpi__value--bad' : ''; };

    // ---------------------------------------------------------------- outcome and feedback
    // Buttons and labels are worked out once when the data arrives (see the note above loadSummary).
    function prepOutcome(o) {
      var room = o.limit.remaining;
      var steps = [1, 4, 13];
      o.buttons = steps.filter(function (w) { return w <= room; }).map(function (w) { return { weeks: w, label: 'Advance ' + w + ' week' + (w === 1 ? '' : 's') }; });
      if (room > 0 && steps.indexOf(room) < 0) o.buttons.push({ weeks: room, label: 'Advance to the limit (' + room + ' weeks)' });
      (o.pools || []).forEach(function (p) { p.readClass = p.forecast.read_key === 'below' ? 'below' : p.forecast.read_key === 'close' ? 'close' : 'above'; });
      (o.dated || []).forEach(function (d) { var t = datedText(d); d.kind_label = t.kind; d.outcome_label = t.outcome; d.outcome_class = t.cls; d.pill = t.pill; d.notable = t.notable; d.counted_text = t.counted; d.showed_text = t.showed; });
      return o;
    }
    // How one item that fell due reads on the page, worked out once when the data arrives: what it was, what the plan counted,
    // what showed up, and what became of it. A seasonal spike is a rate, so its figures are percentages of the pool's usage.
    var pctText = function (x) { var p = x * 100; return (p % 1 ? p.toFixed(1) : p.toFixed(0)) + '%'; };
    function datedText(d) {
      var spike = d.uplift_pct != null;
      var unlogged = d.kind === 'unrecorded';
      var kind = d.kind === 'request' ? 'Request' : d.kind === 'contract' ? 'Contract' : unlogged ? 'Unrecorded demand' : spike ? 'Seasonal spike' : 'Demand step';
      var outcome = d.kind === 'request' ? (d.happened ? 'Went live' : 'Did not go ahead')
        : d.kind === 'contract' ? 'Took effect'
          : unlogged ? 'Nobody told the plan'
            : !d.happened ? 'Did not happen' : d.in_progress ? 'Still running' : 'Happened';
      return {
        kind: kind, outcome: outcome, cls: d.happened ? 'yes' : 'no',
        // the pill's shape says which of three things it was: something that happened as planned, something that did not, or something the plan never saw coming
        pill: unlogged ? 'rqpill--at-risk' : d.happened ? 'rqpill--live' : 'rqpill--lapsed', notable: unlogged || !d.happened,
        counted: unlogged ? 'nothing: no record' : spike ? '+' + pctText(d.uplift_pct) + ' of usage' : n(d.plan_cu) + ' CU' + (d.kind === 'request' ? ' (asked ' + n(d.asked_cu) + ')' : ''),
        showed: !d.happened ? 'nothing' : spike ? '+' + pctText(d.realized_uplift_pct) + ' of usage (' + n(d.realized_cu) + ' CU at its peak)' : n(d.realized_cu) + ' CU',
      };
    }
    // One sentence for the message after an advance: what fell due in it.
    function fellDueText(list) {
      if (!list || !list.length) return '';
      var count = function (f) { return list.filter(f).length; };
      var parts = [];
      var live = count(function (d) { return d.kind === 'request' && d.happened; }); var lapsed = count(function (d) { return d.kind === 'request' && !d.happened; });
      var took = count(function (d) { return d.kind === 'contract'; }); var ev = count(function (d) { return d.kind === 'event' && d.happened; }); var noev = count(function (d) { return d.kind === 'event' && !d.happened; });
      if (live) parts.push(live + ' request' + (live === 1 ? '' : 's') + ' went live');
      if (lapsed) parts.push(lapsed + ' did not go ahead');
      if (took) parts.push(took + ' contract' + (took === 1 ? '' : 's') + ' took effect');
      if (ev) parts.push(ev + ' event' + (ev === 1 ? '' : 's') + ' happened');
      if (noev) parts.push(noev + ' did not');
      var unlogged = count(function (d) { return d.kind === 'unrecorded'; });
      if (unlogged) parts.push(unlogged + ' unrecorded jump' + (unlogged === 1 ? '' : 's') + ' appeared with no record');
      return ' Fell due: ' + parts.join(', ') + '.';
    }
    function loadOutcome() { return api('GET', '/api/outcome').then(function (o) { vm.out = prepOutcome(o); }); }
    vm.advance = function (weeks) {
      vm.outMsg = null;
      api('POST', '/api/lab/advance', { weeks: weeks }).then(function (r) {
        vm.out = prepOutcome(r.outcome);
        var changed = r.changes.filter(function (c) { return c.changed; }).length;
        vm.outMsg = { type: 'success', text: 'Advanced ' + r.advanced + ' week' + (r.advanced === 1 ? '' : 's') + ' to ' + fmtDate(r.to) + '. '
          + r.arrivals.length + ' order' + (r.arrivals.length === 1 ? '' : 's') + ' arrived, ' + r.slips.length + ' slipped, ' + changed + ' of ' + r.changes.length + ' plans changed in this step.' + fellDueText(r.fell_due) };
        return loadSummary();
      }).catch(function (e) { vm.outMsg = { type: 'danger', text: e.message }; });
    };
    // A signed number with thousands separators, like every other figure on the page: +1,152, -0.3
    vm.signed = function (x, digits) {
      var d = digits == null ? 1 : digits;
      var r = Number(x.toFixed(d)); if (r === 0) r = 0;          // never "-0.0"
      return (r >= 0 ? '+' : '') + r.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    };
    vm.fix = function (x, digits) { return x.toFixed(digits == null ? 1 : digits); };
    // A whole number of weeks stays whole; an average is shown to one decimal (never 1.3333333333333333)
    vm.slipText = function (w) { var r = Math.round(w * 10) / 10; var a = Math.abs(r); return r === 0 ? 'on time' : a + ' week' + (a === 1 ? '' : 's') + (r > 0 ? ' late' : ' early'); };
    vm.stateShort = function (s) { return { OVERDUE: 'Overdue', 'ORDER NOW': 'Order now', PLAN: 'Plan', WATCH: 'Watch', OK: 'OK' }[s] || s; };

    // ---------------------------------------------------------------- search box
    vm.onSearch = function () {
      var q = (vm.searchText || '').trim().toLowerCase();
      var hits = [];
      if (q && vm.summary) {
        vm.summary.actions.forEach(function (a) {
          var hay = (a.region_label + ' ' + a.sku_id + ' ' + a.pool_id).toLowerCase();
          if (hay.indexOf(q) >= 0) hits.push({ label: a.region_label + ' · ' + a.sku_id, kind: 'pool', href: '#/pools/' + a.pool_id });
        });
        [['Capacity Planning', '#/planning'], ['Supply view', '#/planning/supply'], ['Demand view', '#/planning/demand'], ['Outcome & Feedback', '#/outcome'], ['Action Queue', '#/actions'], ['Funnels', '#/funnels'], ['Ontology', '#/ontology'], ['SKU lifecycle', '#/lifecycle'], ['Requests', '#/requests'], ['Decisions', '#/decisions'], ['Lab', '#/lab']].forEach(function (p) {
          if (p[0].toLowerCase().indexOf(q) >= 0) hits.push({ label: p[0], kind: 'page', href: p[1] });
        });
      }
      vm.searchHits = hits.slice(0, 6);
    };
    vm.searchKey = function (ev) {
      if (ev.key === 'Enter' && vm.searchHits.length) { $location.path(vm.searchHits[0].href.replace(/^#/, '')); vm.clearSearch(); }
      else if (ev.key === 'Escape') vm.clearSearch();
    };
    vm.clearSearch = function () { vm.searchText = ''; vm.searchHits = []; };

    // ---------------------------------------------------------------- funnels
    // One card per funnel: the pools it flags, most severe first. Computed once when the
    // data loads (see the note above loadSummary about not building objects in templates).
    function funnelCards(s) {
      var rank = function (c) { return c.context_only ? 0 : SEV_RANK[c.severity]; };
      return s.funnels.map(function (f) {
        var flags = []; var quiet = 0; var nodata = 0;
        f.pools.forEach(function (c, i) {
          if (c.status === 'flagged') flags.push({ pool_id: c.pool_id, label: s.pools[i].label, severity: c.severity, context_only: c.context_only, headline: c.headline });
          else if (c.status === 'quiet') quiet++; else nodata++;
        });
        flags.sort(function (x, y) { return rank(y) - rank(x); });
        return { number: f.number, name: f.name, tag: f.tag, standard: f.standard, detects: f.detects, accelerates: f.accelerates,
          primary_sources: f.primary_sources, sources: f.sources, flags: flags.slice(0, 3), quiet: quiet, nodata: nodata, flaggedTotal: flags.length };
      });
    }
    vm.feedFor = function (id) { return vm.funnels ? vm.funnels.feeds.filter(function (f) { return f.feed_id === id; })[0] : null; };
    vm.shortLabel = function (p) { return p.label.split(' · ')[0]; };
    vm.skuShort = function (p) { return p.label.split(' · ')[1].replace('FAB-', ''); };

    // ---------------------------------------------------------------- ontology
    // The utilization history is drawn as a small line against the installed capacity, with the
    // working ceiling as a dashed line. The points are worked out once here, not in the template.
    function loadOntology() {
      return api('GET', '/api/ontology').then(function (o) {
        var W = 260, H = 56, PAD = 3;
        o.pools.forEach(function (p) {
          var s = p.layers.utilization.spark;
          var y = function (v) { return +(H - PAD - (v / s.capacity_cu) * (H - 2 * PAD)).toFixed(1); };
          var step = W / (s.values.length - 1);
          s.points = s.values.map(function (v, i) { return (+(i * step).toFixed(1)) + ',' + y(v); }).join(' ');
          s.ceilingY = y(s.ceiling_cu);
          s.lastY = y(s.values[s.values.length - 1]);
          s.width = W; s.height = H;
        });
        o.layers.forEach(function (l) { l.headlineLabel = o.pools[0].layers[l.id].headline.label; });
        vm.ont = o;
        if (!o.pools.some(function (p) { return p.pool_id === vm.ontPoolId; })) vm.ontPoolId = vm.summary.actions[0].pool_id;
      });
    }
    vm.selectOnt = function (id) { vm.ontPoolId = id; };
    vm.ontPool = function () { return vm.ont ? vm.ont.pools.filter(function (p) { return p.pool_id === vm.ontPoolId; })[0] : null; };
    vm.ontLayer = function (l) { var p = vm.ontPool(); return p ? p.layers[l.id] : null; };
    var LIFECYCLE = { active: 'Active', eol: 'End of life', planned: 'Planned' };
    vm.fmtVal = function (v) {
      if (!v || v.value === null || v.value === undefined) return '—';
      var x = v.value;
      switch (v.unit) {
        case 'cu': return n(x) + ' CU';
        case 'pct': return Math.round(x * 100) + '%';
        case 'date': return fmtDate(x);
        case 'weeks': return n(x) + ' weeks';
        case 'usd': return usd(x);
        case 'count': return n(x);
        case 'hours': return x.toFixed(1) + ' hours';
        case 'score': return x.toFixed(1);
        case 'factor': return x.toFixed(2) + ' ×';
        case 'lifecycle': return LIFECYCLE[x] || x;
        default: return String(x);
      }
    };

    // ---------------------------------------------------------------- lifecycle
    function initConversion(l) {
      var withSuccessor = l.pools.filter(function (p) { var s = l.skus.filter(function (k) { return k.sku_id === p.sku_id; })[0]; return s && s.replaced_by_sku; });
      vm.convPools = withSuccessor;
      if (!vm.cv.pool_id || !withSuccessor.some(function (p) { return p.pool_id === vm.cv.pool_id; })) vm.cv.pool_id = withSuccessor.length ? withSuccessor[0].pool_id : null;
      vm.runConversion(true);
    }
    vm.runConversion = function (reset) {
      if (!vm.cv.pool_id) return;
      var body = { pool_id: vm.cv.pool_id };
      if (!reset && vm.cv.ratio) body.ratio = vm.cv.ratio;
      if (!reset && vm.cv.swap) body.swap_units = vm.cv.swap;
      api('POST', '/api/conversion', body).then(function (r) {
        vm.cvResult = r;
        if (reset) { vm.cv.ratio = r.ratio; vm.cv.swap = r.swap_units; }
      }).catch(fail);
    };
    vm.poolsUsing = function (s) { return s.pools.map(vm.poolName).join(', ') || '—'; };

    // ---------------------------------------------------------------- lab
    vm.applyScenario = function (id) {
      vm.change = null;
      api('POST', '/api/lab/scenarios/' + id + '/apply').then(function (r) {
        vm.change = r;
        return $q.all([loadSummary(), api('GET', '/api/lab').then(function (l) { vm.lab = l; })]);
      }).catch(fail);
    };
    vm.resetLab = function (progress) {
      vm.change = null; vm.labResult = {};
      api('POST', '/api/lab/reset', { progress: !!progress }).then(function () { vm.rqResult = null; return load(); }).catch(fail);
    };
    vm.checkLab = function (ex) {
      api('POST', '/api/lab/check/' + ex.id, { choice: vm.choice[ex.id] }).then(function (r) {
        vm.labResult[ex.id] = r;
        return api('GET', '/api/lab').then(function (l) { vm.lab = l; });
      }).catch(fail);
    };
    vm.labAction = function (a) {
      if (a.type === 'go') vm.goHash(a.hash);
      else if (a.type === 'scenario') vm.applyScenario(a.id);
      else if (a.type === 'reset') vm.resetLab(false);
    };
    vm.changedPools = function () { return vm.change ? vm.change.changes.filter(function (c) { return c.changed; }) : []; };
    vm.flow = [
      { n: 1, h: 'Synthetic estate', p: '6 pools, 52 weeks of usage, incidents, contracts, vendors. Labelled synthetic in every file.' },
      { n: 2, h: '14 funnels', p: 'Each reads its own records and proposes a date, a size or a warning. One is a fitted forecast; the rest are rules.' },
      { n: 3, h: 'Composition', p: 'One rule per dimension: earliest date wins, lead time from the vendor, sizes add up.' },
      { n: 4, h: 'Planning horizon', p: 'Need becomes an order: less supply in flight, plus buffer, rounded to racks, costed.' },
      { n: 5, h: 'Human decision', p: 'A named person approves, changes or declines. The engine cannot approve itself.' },
      { n: 6, h: 'Outcome', p: 'The order joins the pipeline and the plan updates. Disputed funnels are recorded for learning.' },
    ];

    $rootScope.$on('$locationChangeSuccess', route);
    route();
  }]);
})();
