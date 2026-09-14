'use strict';

const fs = require('fs');
const path = require('path');
const { ghGetFile, CONTENT_PATH, send, fail, methodNotAllowed } = require('./_lib');

/** Bundled copy is the last-resort fallback so the public site never breaks. */
function bundled() {
  try {
    return fs.readFileSync(path.join(process.cwd(), CONTENT_PATH), 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD']);

  try {
    const file = await ghGetFile(CONTENT_PATH);
    if (file) {
      JSON.parse(file.text); // never serve a broken payload
      return send(res, 200, req.method === 'HEAD' ? '' : file.text, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Sha': file.sha,
      });
    }
    const local = bundled();
    if (local) {
      return send(res, 200, req.method === 'HEAD' ? '' : local, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Source': 'bundle',
      });
    }
    return send(res, 200, '{}', {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    const local = bundled();
    if (local) {
      return send(res, 200, local, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Source': 'bundle-fallback',
      });
    }
    return fail(res, error);
  }
};
