'use strict';

const {
  loadAdmins,
  bootstrapAdmins,
  verifyPassword,
  createSession,
  setSessionCookie,
  readJSON,
  assertSameOrigin,
  normaliseUsername,
  send,
  fail,
  methodNotAllowed,
  httpError,
} = require('./_lib');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function throttled(ip) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.at > WINDOW_MS) {
    attempts.set(ip, { at: now, count: 1 });
    return false;
  }
  record.count += 1;
  record.at = now;
  if (attempts.size > 500) attempts.clear();
  return record.count > MAX_ATTEMPTS;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    assertSameOrigin(req);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (throttled(ip)) throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');

    const body = await readJSON(req, 16 * 1024);
    const username = normaliseUsername(body.username);
    const password = String(body.password || '');
    if (!username || !password) throw httpError(400, 'Enter your username and password.');

    let store = await loadAdmins();
    if (!store) store = await bootstrapAdmins(username, password);

    const record = store && store.data && Array.isArray(store.data.admins)
      ? store.data.admins.find((a) => normaliseUsername(a.username) === username)
      : null;

    if (!record || !verifyPassword(password, record.password)) {
      throw httpError(401, 'That username and password do not match.');
    }

    const role = record.role === 'super' ? 'super' : 'editor';
    setSessionCookie(res, createSession({ username }));
    attempts.delete(ip);

    return send(res, 200, {
      ok: true,
      user: { username: normaliseUsername(record.username), name: record.name || record.username, email: record.email || '', role },
    });
  } catch (error) {
    return fail(res, error);
  }
};
