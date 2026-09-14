'use strict';

const { currentUser, send, fail, methodNotAllowed } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await currentUser(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return send(res, 401, { ok: false, error: 'Not signed in.' });
    return send(res, 200, { ok: true, user });
  } catch (error) {
    return fail(res, error);
  }
};
