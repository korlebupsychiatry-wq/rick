/*!
 * First-party site analytics for rick-phi-azure.vercel.app
 *
 * Cookieless: nothing is written to storage except an anonymous session id in
 * sessionStorage, which dies with the tab. Do Not Track and Global Privacy
 * Control are respected, and no visitor is tracked from a local or preview
 * host so test traffic never reaches the live report.
 */
(function () {
  'use strict';

  var HOST = location.hostname;
  var PROD_HOST = 'rick-phi-azure.vercel.app';
  var off = /(^|\.)(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(HOST)
    || (/(^|\.)vercel\.app$/.test(HOST) && HOST !== PROD_HOST)
    || /[?&]notrack\b/.test(location.search)
    || /^\/admin/.test(location.pathname)
    || navigator.doNotTrack === '1'
    || window.doNotTrack === '1'
    || navigator.msDoNotTrack === '1'
    || navigator.globalPrivacyControl === true;
  if (off) return;

  var ENDPOINT = '/api/track';
  var SESSION_TTL = 30 * 60 * 1000;
  var FLUSH_EVERY = 20000;

  /* ------------------------------------------------------------- session id */

  function sessionId() {
    var now = Date.now();
    var stamp = 0;
    var id = '';
    try {
      stamp = parseInt(sessionStorage.getItem('_ag_t') || '0', 10) || 0;
      id = sessionStorage.getItem('_ag_s') || '';
    } catch (e) { /* storage unavailable */ }
    if (!id || now - stamp > SESSION_TTL) {
      id = Math.random().toString(36).slice(2) + now.toString(36);
      try { sessionStorage.setItem('_ag_s', id); } catch (e) { /* ignore */ }
    }
    try { sessionStorage.setItem('_ag_t', String(now)); } catch (e) { /* ignore */ }
    return id;
  }

  var sid = sessionId();

  /* ----------------------------------------------------------------- state */

  var pending = [];
  var engaged = 0;          // visible seconds, cumulative
  var reportedEngaged = 0;  // visible seconds already sent to the server
  var maxScroll = 0;
  var seenSections = {};
  var lastTick = Date.now();
  var visible = document.visibilityState !== 'hidden';

  function utm() {
    var out = {};
    try {
      var params = new URLSearchParams(location.search);
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (key) {
        var value = params.get(key);
        if (value) out[key.replace('utm_', '')] = value.slice(0, 60);
      });
    } catch (e) { /* ignore */ }
    return Object.keys(out).length ? out : null;
  }

  var UTM = utm();

  function push(event) {
    if (pending.length > 120) return;
    event.ts = Date.now();
    pending.push(event);
  }

  function payload() {
    return JSON.stringify({
      sid: sid,
      lang: (navigator.language || '').slice(0, 10),
      r: document.referrer || '',
      utm: UTM,
      events: pending
    });
  }

  function flush(beacon) {
    if (!pending.length) return;
    var body = payload();
    pending = [];
    if (beacon && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit',
        mode: 'same-origin'
      }).catch(function () { /* never surface */ });
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- pageview */

  push({
    t: 'pv',
    p: location.pathname,
    ti: (document.title || '').slice(0, 120)
  });

  /* ---------------------------------------------------------------- engagement */

  function tick() {
    var now = Date.now();
    if (visible) engaged += (now - lastTick) / 1000;
    lastTick = now;
  }

  function scrollDepth() {
    var doc = document.documentElement;
    var span = doc.scrollHeight - window.innerHeight;
    if (span <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round((window.scrollY / span) * 100)));
  }

  window.addEventListener('scroll', function () {
    maxScroll = Math.max(maxScroll, scrollDepth());
    queueSections();
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    tick();
    visible = document.visibilityState !== 'hidden';
    lastTick = Date.now();
  });

  /* ----------------------------------------------------------------- sections */

  // Measuring how much of the screen each section covers, rather than the
  // IntersectionObserver ratio, is what makes this work here: most sections are
  // taller than the viewport, so their visible ratio can never reach a threshold
  // such as 0.4 and they would never be recorded. Reading the DOM on each scroll
  // also survives the CMS replacing markup after load.
  function checkSections() {
    var vh = window.innerHeight || 1;
    var sections = document.querySelectorAll('section[id]');
    for (var i = 0; i < sections.length; i += 1) {
      var element = sections[i];
      var id = element.id;
      if (!id || seenSections[id]) continue;
      var rect = element.getBoundingClientRect();
      if (rect.height <= 0) continue;
      var covered = (Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) / vh;
      if (covered >= 0.4) {
        seenSections[id] = true;
        push({ t: 'sec', id: id });
      }
    }
  }

  var sectionQueued = false;
  function queueSections() {
    if (sectionQueued) return;
    sectionQueued = true;
    requestAnimationFrame(function () { sectionQueued = false; checkSections(); });
  }

  window.addEventListener('resize', queueSections);
  window.addEventListener('load', checkSections);
  setTimeout(checkSections, 1200);
  setTimeout(checkSections, 4000);

  /* ------------------------------------------------------------------- clicks */

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var withHandler = target.closest('[onclick]');
    if (withHandler) {
      var code = withHandler.getAttribute('onclick') || '';
      var video = /openVideo\(\s*['"]([^'"]+)/.exec(code);
      if (video) push({ t: 'vid', id: video[1].slice(0, 40) });
      else if (/showModal\(/.test(code)) push({ t: 'ctc' });
    }

    // "Read full publication" opens the paper through a delegated handler.
    if (target.closest('.pub-open-link')) {
      var pub = target.closest('.pub');
      var heading = pub && pub.querySelector('h3, h4, .pub-title');
      push({ t: 'pub', ti: heading ? String(heading.textContent || '').trim().slice(0, 120) : '' });
    }

    var link = target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      var host = '';
      try { host = new URL(href).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { host = ''; }
      if (host && host !== HOST.replace(/^www\./, '')) push({ t: 'out', h: host });
    } else if (link.classList.contains('btn')) {
      push({ t: 'cta', l: String(link.textContent || '').trim().slice(0, 60) });
    }
  }, true);

  /* -------------------------------------------------------------------- exiting */

  // Engagement is sent as the time elapsed since the last report, so a visitor
  // who keeps the tab open is still counted as engaged without waiting for them
  // to leave — otherwise every long read would look like a bounce.
  function reportEngagement() {
    tick();
    var delta = Math.round((engaged - reportedEngaged) * 10) / 10;
    if (delta <= 0) return;
    reportedEngaged = engaged;
    push({ t: 'en', d: delta, sc: maxScroll });
  }

  function finalise(beacon) {
    reportEngagement();
    flush(beacon);
  }

  window.addEventListener('pagehide', function () { finalise(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') finalise(true);
  });

  setInterval(function () {
    reportEngagement();
    if (pending.length) flush(false);
  }, FLUSH_EVERY);
})();
