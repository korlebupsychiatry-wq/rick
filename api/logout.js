'use strict';

const { clearSessionCookie, send, fail, methodNotAllowed } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  } catch (error) {
    return fail(res, error);
  }
};
