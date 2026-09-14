'use strict';

const {
  loadAdmins,
  saveAdmins,
  hashPassword,
  verifyPassword,
  requireUser,
  requireSuper,
  readJSON,
  assertSameOrigin,
  normaliseUsername,
  publicAdmin,
  send,
  fail,
  methodNotAllowed,
  httpError,
} = require('./_lib');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ROLES = ['super', 'editor'];
const MIN_PASSWORD = 8;

function normaliseRole(value) {
  return value === 'super' ? 'super' : 'editor';
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function countSupers(admins) {
  return admins.filter((a) => a.role === 'super').length;
}

async function readStore() {
  const store = await loadAdmins();
  if (!store || !store.data || !Array.isArray(store.data.admins)) {
    throw httpError(500, 'The admin store is unavailable.');
  }
  return store;
}

module.exports = async function handler(req, res) {
  try {
    const user = await requireUser(req);

    /* ----------------------------- list ----------------------------- */
    if (req.method === 'GET') {
      if (user.role !== 'super') {
        return send(res, 200, { ok: true, admins: [], self: user, canManage: false });
      }
      const store = await readStore();
      return send(res, 200, {
        ok: true,
        canManage: true,
        self: user,
        admins: store.data.admins.map(publicAdmin),
      });
    }

    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
    assertSameOrigin(req);

    const body = await readJSON(req, 32 * 1024);
    const action = cleanText(body.action, 40);

    /* ---------------------- change my own password ------------------- */
    if (action === 'self-password') {
      const current = String(body.currentPassword || '');
      const next = String(body.newPassword || '');
      if (next.length < MIN_PASSWORD) throw httpError(400, `Choose a password of at least ${MIN_PASSWORD} characters.`);
      const store = await readStore();
      const record = store.data.admins.find((a) => normaliseUsername(a.username) === user.username);
      if (!record || !verifyPassword(current, record.password)) throw httpError(401, 'Your current password is not correct.');
      record.password = hashPassword(next);
      await saveAdmins(store.data, store.sha, `CMS: password change for ${user.username}`);
      return send(res, 200, { ok: true, admins: store.data.admins.map(publicAdmin) });
    }

    /* ------------------ everything below is super only --------------- */
    await requireSuper(req);
    const store = await readStore();
    const admins = store.data.admins;

    if (action === 'create') {
      const username = normaliseUsername(body.username);
      const password = String(body.password || '');
      if (!USERNAME_RE.test(username)) {
        throw httpError(400, 'Usernames use 3–32 characters: letters, numbers, dots, dashes or underscores.');
      }
      if (password.length < MIN_PASSWORD) throw httpError(400, `Choose a password of at least ${MIN_PASSWORD} characters.`);
      if (admins.some((a) => normaliseUsername(a.username) === username)) {
        throw httpError(409, 'That username already exists.');
      }
      admins.push({
        username,
        name: cleanText(body.name, 80) || username,
        email: cleanText(body.email, 120),
        role: normaliseRole(body.role),
        createdAt: new Date().toISOString(),
        createdBy: user.username,
        password: hashPassword(password),
      });
      await saveAdmins(store.data, store.sha, `CMS: add admin ${username}`);
      return send(res, 200, { ok: true, admins: admins.map(publicAdmin) });
    }

    if (action === 'update') {
      const username = normaliseUsername(body.username);
      const record = admins.find((a) => normaliseUsername(a.username) === username);
      if (!record) throw httpError(404, 'No such admin.');
      const role = normaliseRole(body.role);
      if (record.role === 'super' && role !== 'super' && countSupers(admins) <= 1) {
        throw httpError(400, 'There must always be at least one super admin.');
      }
      record.role = role;
      if (body.name !== undefined) record.name = cleanText(body.name, 80);
      if (body.email !== undefined) record.email = cleanText(body.email, 120);
      if (body.password) {
        const password = String(body.password);
        if (password.length < MIN_PASSWORD) throw httpError(400, `Choose a password of at least ${MIN_PASSWORD} characters.`);
        record.password = hashPassword(password);
      }
      await saveAdmins(store.data, store.sha, `CMS: update admin ${username}`);
      return send(res, 200, { ok: true, admins: admins.map(publicAdmin) });
    }

    if (action === 'delete') {
      const username = normaliseUsername(body.username);
      if (username === user.username) throw httpError(400, 'You cannot remove your own account.');
      const index = admins.findIndex((a) => normaliseUsername(a.username) === username);
      if (index === -1) throw httpError(404, 'No such admin.');
      if (admins[index].role === 'super' && countSupers(admins) <= 1) {
        throw httpError(400, 'There must always be at least one super admin.');
      }
      admins.splice(index, 1);
      await saveAdmins(store.data, store.sha, `CMS: remove admin ${username}`);
      return send(res, 200, { ok: true, admins: admins.map(publicAdmin) });
    }

    throw httpError(400, 'Unknown action.');
  } catch (error) {
    return fail(res, error);
  }
};
