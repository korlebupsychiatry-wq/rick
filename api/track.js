'use strict';

/**
 * Analytics ingestion.
 *
 * Unauthenticated by necessity (it runs for anonymous visitors), so it is
 * deliberately unforgiving: same-site requests only, a small payload cap, a
 * fixed event vocabulary, and per-IP throttling. Nothing the client sends is
 * stored verbatim — every field is normalised and length-capped first.
 *
 * The endpoint always answers 204, even when storage is unavailable, so a
 * tracking problem can never break the public page.
 */

const crypto = require('crypto');
const { readRaw, httpError, fail, methodNotAllowed } = require('./_lib');
const {
  classifyReferrer,
  classifyChannelWithCampaign,
  classifyUA,
  isBot,
  visitorHash,
  dateKey,
  writeBatch,
  str,
  num,
} = require('./_analytics');

const MAX_BODY = 64 * 1024;
const MAX_EVENTS = 60;
const ALLOWED_TYPES = new Set(['pv', 'sec', 'en', 'out', 'vid', 'pub', 'ctc', 'cta']);

const buckets = new Map();
const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = 150;

function rateLimited(ip) {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    buckets.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now - value.start > RATE_WINDOW) buckets.delete(key);
  }
  return entry.count > RATE_MAX;
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value == null ? '' : value);
}

function sameSite(req) {
  const origin = firstHeader(req.headers.origin);
  const host = firstHeader(req.headers.host);
  const fetchSite = firstHeader(req.headers['sec-fetch-site']);
  if (origin) {
    try {
      if (new URL(origin).host === host) return true;
    } catch (e) { /* fall through */ }
  }
  return !origin && (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === '');
}

async function readBody(req) {
  const raw = await readRaw(req, MAX_BODY);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw httpError(400, 'Malformed payload.');
  }
}

function cleanPath(value) {
  let p = str(value, 300);
  try {
    if (/^https?:/i.test(p)) p = new URL(p).pathname;
  } catch (e) { /* keep as-is */ }
  const cut = p.split('?')[0].split('#')[0];
  return str(cut, 200) || '/';
}

function cleanReferrer(value) {
  const raw = str(value, 400);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 300);
  } catch (e) {
    return '';
  }
}

function cleanUtm(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of ['source', 'medium', 'campaign']) {
    const v = str(value[key], 60).toLowerCase();
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

function normaliseEvent(input, baseTime, index, context) {
  if (!input || typeof input !== 'object') return null;
  const type = str(input.t, 8);
  if (!ALLOWED_TYPES.has(type)) return null;

  const record = {
    t: type,
    ts: baseTime + index,
    sid: context.sid,
    vh: context.vh,
    c: context.country,
    rg: context.region,
    dev: context.device,
    br: context.browser,
    os: context.os,
    lg: context.language,
  };

  switch (type) {
    case 'pv':
      record.p = cleanPath(input.p);
      record.rf = context.referrerHost;
      record.ch = context.channel;
      if (context.utm) record.ut = context.utm;
      break;
    case 'sec':
      record.id = str(input.id, 40);
      if (!record.id) return null;
      break;
    case 'en':
      record.d = num(input.d, 3600);
      record.sc = num(input.sc, 100);
      if (!record.d && !record.sc) return null;
      break;
    case 'out':
      record.h = str(input.h, 80).toLowerCase().replace(/^www\./, '');
      if (!record.h) return null;
      break;
    case 'vid':
      record.id = str(input.id, 40);
      if (!record.id) return null;
      break;
    case 'pub':
      record.ti = str(input.ti, 120);
      break;
    case 'cta':
      record.l = str(input.l, 60);
      if (!record.l) return null;
      break;
    default:
      break;
  }
  return record;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    if (!sameSite(req)) throw httpError(403, 'Cross-site requests are not accepted.');
    // Global Privacy Control and Do Not Track are honoured server-side too.
    if (firstHeader(req.headers['sec-gpc']) === '1' || firstHeader(req.headers.dnt) === '1') {
      res.statusCode = 204;
      return res.end();
    }

    const ip = firstHeader(req.headers['x-forwarded-for']).split(',')[0].trim() || firstHeader(req.headers['x-real-ip']) || 'unknown';
    if (rateLimited(ip)) {
      res.statusCode = 429;
      return res.end();
    }

    const ua = firstHeader(req.headers['user-agent']);
    if (isBot(ua)) {
      res.statusCode = 204;
      return res.end();
    }

    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
    if (!events.length) {
      res.statusCode = 204;
      return res.end();
    }

    const sid = str(body.sid, 40) || crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const selfHost = firstHeader(req.headers.host);
    const referrer = classifyReferrer(cleanReferrer(body.r), selfHost.replace(/^www\./, ''));
    const utm = cleanUtm(body.utm);
    const uaInfo = classifyUA(ua);
    const context = {
      sid,
      vh: visitorHash(ip, ua, dateKey(now).slice(0, 7)),
      country: str(firstHeader(req.headers['x-vercel-ip-country']), 2),
      region: str(firstHeader(req.headers['x-vercel-ip-country-region']), 8),
      device: uaInfo.device,
      browser: uaInfo.browser,
      os: uaInfo.os,
      language: str(body.lang, 10),
      referrerHost: referrer.host,
      channel: classifyChannelWithCampaign(referrer.channel, utm),
      utm,
    };

    const records = [];
    events.forEach((event, index) => {
      const record = normaliseEvent(event, now, index, context);
      if (record) records.push(record);
    });

    if (!records.length) {
      res.statusCode = 204;
      return res.end();
    }

    await writeBatch(records);
    res.statusCode = 204;
    return res.end();
  } catch (error) {
    // Never surface tracking failures to the visitor.
    if (process.env.VERCEL_ENV !== 'production') return fail(res, error);
    console.error('track failed', error && error.message);
    res.statusCode = 204;
    return res.end();
  }
};
