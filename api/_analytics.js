'use strict';

/**
 * First-party analytics: collection, storage and aggregation.
 *
 * Storage is a private Vercel Blob store addressed over its REST API, so the
 * deployment keeps its zero-dependency shape.
 *
 *   ev/<YYYY-MM-DD>/<ms>-<rand>.json   raw batches, one blob per browser flush
 *   dy/<YYYY-MM-DD>.json               compacted day rollup
 *
 * Nothing here stores an IP address, a user agent string, or a cookie. The
 * visitor key is an HMAC of (ip, user agent) under a salt that rolls monthly,
 * so a visitor cannot be followed beyond the month and the value is useless to
 * anyone without the server key.
 */

const crypto = require('crypto');
const { httpError } = require('./_lib');

const BLOB_BASE = 'https://blob.vercel-storage.com';
const BLOB_API_VERSION = '12';
const BLOB_STORE_ID = process.env.BLOB_STORE_ID || 'store_y6NnAnqPCuqCzGuJ';

const RAW_PREFIX = 'ev/';
const DAY_PREFIX = 'dy/';

const MAX_VISITOR_HASHES_PER_DAY = 5000;
const MAX_RAW_BLOBS_PER_DAY = 20000;

/* ------------------------------------------------------------------ utilities */

function str(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function num(value, max) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100) / 100, max == null ? 86400 : max);
}

function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function dayKeysBack(days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) out.push(dateKey(now - i * 86400000));
  return out;
}

/* --------------------------------------------------------------- blob storage */

function blobAuth() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw httpError(500, 'Analytics storage is not configured.');
  const headers = {
    authorization: `Bearer ${token}`,
    'x-api-version': BLOB_API_VERSION,
    'x-vercel-blob-access': 'private',
  };
  if (BLOB_STORE_ID) headers['x-vercel-blob-store-id'] = BLOB_STORE_ID;
  return headers;
}

async function blobPutJson(pathname, value) {
  const res = await fetch(`${BLOB_BASE}/?pathname=${encodeURIComponent(pathname)}`, {
    method: 'PUT',
    headers: {
      ...blobAuth(),
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Blob write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function blobListAll(prefix, max) {
  const out = [];
  let cursor = null;
  const cap = max || 5000;
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: '1000' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${BLOB_BASE}/?${params.toString()}`, { headers: blobAuth() });
    if (!res.ok) throw new Error(`Blob list failed (${res.status})`);
    const page = await res.json();
    for (const blob of page.blobs || []) out.push(blob);
    if (!page.hasMore || !page.cursor || out.length >= cap) break;
    cursor = page.cursor;
  }
  return out.slice(0, cap);
}

async function blobReadJson(blob) {
  const res = await fetch(blob.url, { headers: blobAuth() });
  if (!res.ok) throw new Error(`Blob read failed (${res.status})`);
  return res.json();
}

/** Runs `worker` over `items` with a bounded number of reads in flight. */
async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = [];
  const size = Math.min(limit, items.length);
  for (let i = 0; i < size; i += 1) {
    runners.push((async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    })());
  }
  await Promise.all(runners);
}

async function blobDelete(urls) {
  if (!urls.length) return;
  for (let i = 0; i < urls.length; i += 100) {
    const chunk = urls.slice(i, i + 100);
    const res = await fetch(`${BLOB_BASE}/delete`, {
      method: 'POST',
      headers: { ...blobAuth(), 'content-type': 'application/json' },
      body: JSON.stringify({ urls: chunk }),
    });
    if (!res.ok) throw new Error(`Blob delete failed (${res.status})`);
  }
}

/* ----------------------------------------------------------- classification */

const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave|startpage|qwant|ask)\./;
const SOCIAL_HOSTS = /(^|\.)(linkedin|lnkd|facebook|fb|twitter|x|t|instagram|tiktok|reddit|mastodon|bsky|bsky\.app|youtube|youtu|pinterest|threads|whatsapp|telegram|t)\./;

function classifyReferrer(referrer, selfHost) {
  let host = '';
  try {
    if (referrer) host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    host = '';
  }
  let channel = 'referral';
  if (!host) channel = 'direct';
  else if (selfHost && host === selfHost) channel = 'internal';
  else if (SEARCH_HOSTS.test(host)) channel = 'search';
  else if (SOCIAL_HOSTS.test(host)) channel = 'social';
  return { host: host || '(direct)', channel };
}

function classifyChannelWithCampaign(base, utm) {
  const medium = (utm && utm.medium ? String(utm.medium) : '').toLowerCase();
  if (medium) {
    if (/email|newsletter/.test(medium)) return 'email';
    if (/cpc|ppc|paid|display|ads?$/.test(medium)) return 'paid';
    if (/social/.test(medium)) return 'social';
    if (/organic|seo/.test(medium)) return 'search';
    if (/referral/.test(medium)) return 'referral';
  }
  return base;
}

function classifyUA(ua) {
  const s = ua || '';
  let device = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) device = 'tablet';
  else if (/Mobi|Android|iPhone|iPod|Windows Phone|BlackBerry/i.test(s)) device = 'mobile';

  let browser = 'Other';
  if (/Edg[A-Za-z]*\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(s)) browser = 'Firefox';
  else if (/CriOS/.test(s)) browser = 'Chrome';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  else if (!s) browser = 'Unknown';

  let os = 'Other';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  else if (!s) os = 'Unknown';

  return { device, browser, os };
}

function isBot(ua) {
  return /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|pinterest|vkshare|whatsapp|telegrambot|headless|lighthouse|pingdom|uptimerobot|monitoring|preview|curl|wget|python-requests|axios|node-fetch|go-http/i.test(ua || '');
}

function visitorHash(ip, ua, monthKey) {
  const key = process.env.ADMIN_KEY || process.env.SESSION_SECRET || 'rw-analytics';
  const salt = crypto.createHmac('sha256', key).update(`analytics:${monthKey}`).digest();
  return crypto.createHmac('sha256', salt).update(`${ip}|${ua}`).digest('hex').slice(0, 16);
}

/* -------------------------------------------------------------- day rollups */

function emptyDay(key) {
  return {
    d: key,
    views: 0,
    sess: 0,
    vis: 0,
    bounce: 0,
    durSum: 0,
    durN: 0,
    sessDurSum: 0,
    scroll: { 25: 0, 50: 0, 75: 0, 100: 0 },
    pages: {},
    sections: {},
    refs: {},
    channels: {},
    campaigns: {},
    countries: {},
    regions: {},
    devices: {},
    browsers: {},
    os: {},
    langs: {},
    events: {},
    entry: {},
    exit: {},
    hourly: new Array(24).fill(0),
    vh: [],
    firstTs: null,
    lastTs: null,
    capped: false,
  };
}

function bump(map, key, by) {
  if (!key) return;
  map[key] = (map[key] || 0) + (by == null ? 1 : by);
}

/**
 * Folds normalised event records into a day document. Records must all belong
 * to the same calendar day; per-session measures are derived here because the
 * raw records are not retained after compaction.
 */
function mergeRecords(day, records) {
  const sessions = new Map();
  const visitors = new Set(day.vh || []);
  const sorted = records.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

  for (const rec of sorted) {
    const sid = rec.sid || 'anon';
    if (!sessions.has(sid)) sessions.set(sid, { views: 0, dur: 0, scroll: 0, pages: [], dims: {} });
    const session = sessions.get(sid);
    const ts = rec.ts || 0;
    if (ts) {
      if (day.firstTs === null || ts < day.firstTs) day.firstTs = ts;
      if (day.lastTs === null || ts > day.lastTs) day.lastTs = ts;
    }
    if (rec.vh) visitors.add(rec.vh);

    // Audience dimensions describe a visitor, not an event: remember them once
    // per session and count them after the loop so an active visitor cannot
    // inflate the country or device totals.
    const dims = session.dims;
    if (!dims.c && rec.c) dims.c = rec.c;
    if (!dims.rg && rec.rg) dims.rg = rec.rg;
    if (!dims.dev && rec.dev) dims.dev = rec.dev;
    if (!dims.br && rec.br) dims.br = rec.br;
    if (!dims.os && rec.os) dims.os = rec.os;
    if (!dims.lg && rec.lg) dims.lg = rec.lg;
    if (!dims.rf && rec.rf) dims.rf = rec.rf;
    if (!dims.ch && rec.ch) dims.ch = rec.ch;
    if (!dims.ut && rec.ut) dims.ut = rec.ut;

    switch (rec.t) {
      case 'pv':
        day.views += 1;
        session.views += 1;
        session.pages.push(rec.p || '/');
        if (rec.p) bump(day.pages, rec.p);
        if (ts) day.hourly[new Date(ts).getUTCHours()] += 1;
        break;
      case 'sec':
        if (rec.id) bump(day.sections, rec.id);
        break;
      case 'en':
        // `d` is the time since the previous report, so these add up to the
        // session's engaged time. The average is worked out per session below,
        // otherwise it would just measure how often the browser flushed.
        session.dur += num(rec.d, 86400);
        if (rec.sc) session.scroll = Math.max(session.scroll, num(rec.sc, 100));
        break;
      case 'out':
        bump(day.events, `outbound:${rec.h || 'unknown'}`);
        break;
      case 'vid':
        bump(day.events, 'video:play');
        break;
      case 'pub':
        bump(day.events, 'publication:open');
        break;
      case 'ctc':
        bump(day.events, 'contact:open');
        break;
      case 'cta':
        bump(day.events, `cta:${rec.l || 'unknown'}`);
        break;
      default:
        break;
    }
  }

  day.sess += sessions.size;
  day.vis = visitors.size;
  if (visitors.size > MAX_VISITOR_HASHES_PER_DAY) {
    day.vh = Array.from(visitors).slice(0, MAX_VISITOR_HASHES_PER_DAY);
    if (!day.capped) { day.capped = true; day.vis = day.vh.length; }
  } else {
    day.vh = Array.from(visitors);
  }

  for (const session of sessions.values()) {
    day.sessDurSum += session.dur;
    if (session.dur > 0) { day.durSum += session.dur; day.durN += 1; }
    if (session.views <= 1 && session.dur < 10) day.bounce += 1;
    const dims = session.dims;
    if (dims.c) bump(day.countries, dims.c);
    if (dims.rg) bump(day.regions, `${dims.c || '??'}/${dims.rg}`);
    if (dims.dev) bump(day.devices, dims.dev);
    if (dims.br) bump(day.browsers, dims.br);
    if (dims.os) bump(day.os, dims.os);
    if (dims.lg) bump(day.langs, dims.lg);
    if (dims.rf) bump(day.refs, dims.rf);
    if (dims.ch) bump(day.channels, dims.ch);
    if (dims.ut && dims.ut.source) {
      const label = [dims.ut.source, dims.ut.medium, dims.ut.campaign].filter(Boolean).join(' / ');
      bump(day.campaigns, label);
    }
    const depth = session.scroll;
    if (depth >= 25) day.scroll[25] += 1;
    if (depth >= 50) day.scroll[50] += 1;
    if (depth >= 75) day.scroll[75] += 1;
    if (depth >= 100) day.scroll[100] += 1;
    if (session.pages.length) {
      bump(day.entry, session.pages[0]);
      bump(day.exit, session.pages[session.pages.length - 1]);
    }
  }
  return day;
}

/* ------------------------------------------------------------ raw event path */

function rawPath(dayKey) {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${RAW_PREFIX}${dayKey}/${stamp}-${rand}.json`;
}

const rawCounts = new Map();

async function writeBatch(records) {
  const dayKey = dateKey(Date.now());
  // Guard against a flood filling the store: stop appending once a day is huge.
  // Re-listing the whole day on every batch would make writes progressively
  // slower, so a warm instance only re-checks every 25 batches.
  const counted = rawCounts.get(dayKey) || 0;
  if (counted >= MAX_RAW_BLOBS_PER_DAY) return { stored: 0, throttled: true };
  if (counted % 25 === 0) {
    const existing = await blobListAll(`${RAW_PREFIX}${dayKey}/`, MAX_RAW_BLOBS_PER_DAY + 1);
    rawCounts.set(dayKey, existing.length);
    if (existing.length >= MAX_RAW_BLOBS_PER_DAY) return { stored: 0, throttled: true };
  }
  await blobPutJson(rawPath(dayKey), { r: records });
  rawCounts.set(dayKey, (rawCounts.get(dayKey) || 0) + 1);
  return { stored: records.length, throttled: false };
}

async function readRawDay(dayKey) {
  const blobs = await blobListAll(`${RAW_PREFIX}${dayKey}/`, MAX_RAW_BLOBS_PER_DAY);
  const day = emptyDay(dayKey);
  const records = [];
  for (let i = 0; i < blobs.length; i += 25) {
    const chunk = blobs.slice(i, i + 25);
    const loaded = await Promise.all(chunk.map((b) => blobReadJson(b).catch(() => null)));
    for (const doc of loaded) if (doc && Array.isArray(doc.r)) records.push(...doc.r);
  }
  mergeRecords(day, records);
  return { day, blobs, records };
}

async function readDay(dayKey) {
  const stored = await blobListAll(`${DAY_PREFIX}${dayKey}.json`, 1);
  if (stored.length) {
    const doc = await blobReadJson(stored[0]).catch(() => null);
    if (doc) return { day: doc, compacted: true, blobs: [] };
  }
  const raw = await readRawDay(dayKey);
  return { day: raw.day, compacted: false, blobs: raw.blobs };
}

/**
 * Loads every day in a range with two listings in total — one for raw batches,
 * one for rollups — then reads only the days that actually hold data, a bounded
 * number at a time. Listing each day separately costs two round trips a day,
 * which is what made a 30-day report take half a minute.
 */
async function readRange(keys) {
  const wanted = new Set(keys);
  const [rawBlobs, rollBlobs] = await Promise.all([
    blobListAll(RAW_PREFIX, MAX_RAW_BLOBS_PER_DAY),
    blobListAll(DAY_PREFIX, 2000),
  ]);

  const rawByDay = new Map();
  for (const blob of rawBlobs) {
    const key = String(blob.pathname).slice(RAW_PREFIX.length).split('/')[0];
    if (!wanted.has(key)) continue;
    if (!rawByDay.has(key)) rawByDay.set(key, []);
    rawByDay.get(key).push(blob);
  }

  const rollByDay = new Map();
  for (const blob of rollBlobs) {
    const key = String(blob.pathname).slice(DAY_PREFIX.length).replace(/\.json$/, '');
    if (wanted.has(key)) rollByDay.set(key, blob);
  }

  const jobs = [];
  for (const key of keys) {
    const roll = rollByDay.get(key);
    if (roll) jobs.push({ key, blob: roll, rollup: true });
    for (const blob of rawByDay.get(key) || []) jobs.push({ key, blob, rollup: false });
  }

  const rollDocs = new Map();
  const rawRecords = new Map();
  await mapLimit(jobs, 12, async (job) => {
    const doc = await blobReadJson(job.blob).catch(() => null);
    if (!doc) return;
    if (job.rollup) {
      rollDocs.set(job.key, doc);
    } else if (Array.isArray(doc.r)) {
      if (!rawRecords.has(job.key)) rawRecords.set(job.key, []);
      rawRecords.get(job.key).push(...doc.r);
    }
  });

  return keys.map((key) => {
    const day = emptyDay(key);
    let compacted = false;
    const roll = rollDocs.get(key);
    if (roll) { Object.assign(day, roll); day.d = key; compacted = true; }
    const records = rawRecords.get(key);
    if (records && records.length) mergeRecords(day, records);
    return { day, compacted, blobs: rawByDay.get(key) || [] };
  });
}

/* -------------------------------------------------------------- compaction */

/**
 * Folds one finished day of raw batches into a single rollup blob and drops the
 * raw batches. Safe to run repeatedly: a day that already has a rollup is left
 * alone, and the rollup is written before anything is deleted.
 */
async function compactDay(dayKey) {
  const stored = await blobListAll(`${DAY_PREFIX}${dayKey}.json`, 1);
  if (stored.length) {
    const leftover = await blobListAll(`${RAW_PREFIX}${dayKey}/`, MAX_RAW_BLOBS_PER_DAY);
    if (leftover.length) await blobDelete(leftover.map((b) => b.url));
    return { day: dayKey, skipped: true, removed: leftover.length };
  }
  const { day, blobs } = await readRawDay(dayKey);
  if (!blobs.length) return { day: dayKey, empty: true, removed: 0 };
  day.compactedAt = new Date().toISOString();
  await blobPutJson(`${DAY_PREFIX}${dayKey}.json`, day);
  await blobDelete(blobs.map((b) => b.url));
  return { day: dayKey, views: day.views, sessions: day.sess, removed: blobs.length };
}

async function compactFinishedDays(maxDays) {
  const keys = dayKeysBack(3).slice(0, -1); // yesterday and the day before
  const results = [];
  for (const key of keys.slice(0, maxDays || 2)) {
    try {
      results.push(await compactDay(key));
    } catch (error) {
      results.push({ day: key, error: String(error.message || error) });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ reporting */

const RANGES = { 1: 1, 7: 7, 30: 30, 90: 90, 365: 365 };

function sumMaps(target, source) {
  for (const [k, v] of Object.entries(source || {})) target[k] = (target[k] || 0) + v;
}

function topEntries(map, limit, filter) {
  return Object.entries(map || {})
    .filter(([k]) => (filter ? filter(k) : true))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

async function buildReport(days) {
  const keys = dayKeysBack(days);
  const loaded = await readRange(keys);

  const total = emptyDay('range');
  const timeseries = [];
  const seenOn = new Map();

  for (const entry of loaded) {
    const day = entry.day;
    total.views += day.views || 0;
    total.sess += day.sess || 0;
    total.vis += day.vis || 0;
    total.bounce += day.bounce || 0;
    total.durSum += day.durSum || 0;
    total.durN += day.durN || 0;
    total.sessDurSum += day.sessDurSum || 0;
    for (const k of Object.keys(total.scroll)) total.scroll[k] += (day.scroll && day.scroll[k]) || 0;
    for (let h = 0; h < 24; h += 1) total.hourly[h] += (day.hourly && day.hourly[h]) || 0;
    for (const field of ['pages', 'sections', 'refs', 'channels', 'campaigns', 'countries', 'regions', 'devices', 'browsers', 'os', 'langs', 'events', 'entry', 'exit']) {
      sumMaps(total[field], day[field]);
    }
    for (const hash of day.vh || []) {
      if (!seenOn.has(hash)) seenOn.set(hash, new Set());
      seenOn.get(hash).add(day.d);
    }
    timeseries.push({
      date: day.d,
      views: day.views || 0,
      visitors: day.vis || 0,
      sessions: day.sess || 0,
      bounce: day.bounce || 0,
      avgTime: day.sess ? Math.round(day.sessDurSum / day.sess) : 0,
      compacted: entry.compacted,
    });
  }

  const uniqueVisitors = seenOn.size;
  let returning = 0;
  for (const days2 of seenOn.values()) if (days2.size > 1) returning += 1;

  const views = total.views;
  const sessions = total.sess;

  return {
    range: { days, from: keys[0], to: keys[keys.length - 1] },
    generatedAt: new Date().toISOString(),
    summary: {
      visitors: uniqueVisitors,
      newVisitors: uniqueVisitors - returning,
      returningVisitors: returning,
      sessions,
      pageviews: views,
      pagesPerSession: sessions ? Math.round((views / sessions) * 100) / 100 : 0,
      bounceRate: sessions ? Math.round((total.bounce / sessions) * 1000) / 10 : 0,
      avgSessionSeconds: sessions ? Math.round(total.sessDurSum / sessions) : 0,
      avgEngagedSeconds: total.durN ? Math.round(total.durSum / total.durN) : 0,
      viewsPerVisitor: uniqueVisitors ? Math.round((views / uniqueVisitors) * 100) / 100 : 0,
    },
    timeseries,
    hourly: total.hourly,
    scroll: total.scroll,
    pages: topEntries(total.pages, 12),
    sections: topEntries(total.sections, 12),
    acquisition: {
      channels: topEntries(total.channels, 10),
      referrers: topEntries(total.refs, 15),
      campaigns: topEntries(total.campaigns, 10),
    },
    audience: {
      countries: topEntries(total.countries, 15),
      regions: topEntries(total.regions, 10),
      devices: topEntries(total.devices, 6),
      browsers: topEntries(total.browsers, 8),
      os: topEntries(total.os, 8),
      languages: topEntries(total.langs, 8),
    },
    engagement: {
      events: topEntries(total.events, 15),
      entry: topEntries(total.entry, 8),
      exit: topEntries(total.exit, 8),
      scroll: total.scroll,
    },
    daily: loaded.map((entry) => ({
      date: entry.day.d,
      views: entry.day.views || 0,
      sessions: entry.day.sess || 0,
      visitors: entry.day.vis || 0,
      bounce: entry.day.bounce || 0,
      avgTime: entry.day.sess ? Math.round(entry.day.sessDurSum / entry.day.sess) : 0,
      compacted: entry.compacted,
    })),
  };
}

/**
 * Visitors seen in the last half hour, read from the live raw batches. Only
 * today's uncompacted data is consulted, so this stays cheap.
 */
async function realtime(minutes) {
  const window = (minutes || 30) * 60000;
  const since = Date.now() - window;
  try {
    const { records } = await readRawDay(dateKey(Date.now()));
    const visitors = new Set();
    let views = 0;
    let sessions = new Set();
    for (const rec of records) {
      if ((rec.ts || 0) < since) continue;
      if (rec.t === 'pv') { views += 1; sessions.add(rec.sid); }
      if (rec.vh) visitors.add(rec.vh);
    }
    return { minutes: minutes || 30, visitors: visitors.size, pageviews: views, sessions: sessions.size };
  } catch (error) {
    return { minutes: minutes || 30, visitors: 0, pageviews: 0, sessions: 0, error: true };
  }
}

module.exports = {
  RANGES,
  emptyDay,
  mergeRecords,
  classifyReferrer,
  classifyChannelWithCampaign,
  classifyUA,
  isBot,
  visitorHash,
  dateKey,
  dayKeysBack,
  writeBatch,
  readDay,
  readRange,
  compactDay,
  compactFinishedDays,
  buildReport,
  realtime,
  blobListAll,
  blobPutJson,
  str,
  num,
  topEntries,
};
