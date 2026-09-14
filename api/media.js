'use strict';

const { rawUrl, send, fail, methodNotAllowed, httpError } = require('./_lib');

/**
 * Serves uploaded media straight from the repository's public CDN.
 *
 * Only the uploads/ prefix is reachable — the repo also holds files that must
 * never be served (the encrypted admin store, source documents), so anything
 * else is refused rather than proxied.
 */
const ALLOWED = /^uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD']);

  try {
    const url = new URL(req.url, 'http://localhost');
    const path = (url.searchParams.get('path') || '').replace(/\\/g, '/').trim();
    if (!ALLOWED.test(path)) throw httpError(404, 'Not found');

    res.statusCode = 301;
    res.setHeader('Location', rawUrl(path));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end();
  } catch (error) {
    return fail(res, error);
  }
};
