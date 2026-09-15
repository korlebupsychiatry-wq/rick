'use strict';

/**
 * Folds raw analytics batches into daily rollups.
 *
 * Runs on Vercel's daily cron, and can also be called by a signed-in super
 * admin. Reports do not depend on it — they can read raw batches directly —
 * so a missed run only costs a little read time.
 */

const { requireSuper, send, fail, methodNotAllowed, httpError } = require('./_lib');
const { compactFinishedDays } = require('./_analytics');

function cronAuthorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = String(req.headers.authorization || '');
  return auth === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    let viaCron = cronAuthorised(req);
    if (!viaCron) await requireSuper(req);

    const url = new URL(req.url, 'http://localhost');
    const depth = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 14);
    const results = await compactFinishedDays(depth);
    return send(res, 200, { ok: true, via: viaCron ? 'cron' : 'admin', results });
  } catch (error) {
    if (error && error.status) return fail(res, error);
    return fail(res, httpError(500, 'Compaction failed.'));
  }
};
