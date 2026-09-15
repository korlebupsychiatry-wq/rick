'use strict';

/**
 * Analytics report for the studio. Super admins only — the numbers describe
 * everyone who has visited the public site, so they are not shown to editors.
 */

const { requireSuper, send, fail, methodNotAllowed, httpError } = require('./_lib');
const { buildReport, realtime, compactFinishedDays } = require('./_analytics');

/* Today keeps moving, so it is cached briefly; finished days barely change. */
const cacheMs = (days) => (days <= 1 ? 60 * 1000 : 5 * 60 * 1000);
const cache = new Map();
let lastCompactionAttempt = 0;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    await requireSuper(req, 'The analytics report is only available to super admins.');

    const url = new URL(req.url, 'http://localhost');
    const requested = parseInt(url.searchParams.get('days') || '30', 10);
    const days = [1, 7, 30, 90, 365].includes(requested) ? requested : 30;

    const now = Date.now();
    const hit = cache.get(days);
    let report;
    if (hit && now - hit.at < cacheMs(days)) {
      report = hit.value;
    } else {
      report = await buildReport(days);
      cache.set(days, { at: now, value: report });
    }

    const withRealtime = url.searchParams.get('realtime') !== '0';
    const live = withRealtime ? await realtime(30) : null;

    // Roll finished days into single rollups in the background. Reports work
    // from raw batches regardless, so this is purely an efficiency measure.
    if (now - lastCompactionAttempt > 30 * 60 * 1000) {
      lastCompactionAttempt = now;
      compactFinishedDays(2).catch(() => {});
    }

    return send(res, 200, { ok: true, report, realtime: live }, { 'Cache-Control': 'no-store' });
  } catch (error) {
    if (error && error.status) return fail(res, error);
    return fail(res, httpError(500, 'Could not build the report.'));
  }
};
