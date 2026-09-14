'use strict';

/**
 * Shared server-side helpers for the site CMS.
 *
 * Persistence is the GitHub repository itself, written through the Contents API
 * with a server-side token. Nothing here is ever shipped to the browser, and no
 * secret is committed to the repo.
 */

const crypto = require('crypto');

const OWNER = process.env.CMS_GH_OWNER || 'korlebupsychiatry-wq';
const REPO = process.env.CMS_GH_REPO || 'rick';
const BRANCH = process.env.CMS_GH_BRANCH || 'main';
const API = 'https://api.github.com';

const SESSION_COOKIE = 'rw_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMINS_PATH = '.cms/admins.json';
const CONTENT_PATH = 'content.json';

const IS_PROD = process.env.VERCEL_ENV === 'production';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ------------------------------------------------------------------ *
 * GitHub Contents API
 * ------------------------------------------------------------------ */

function requireToken() {
  const token = process.env.GH_TOKEN;
  if (!token) throw httpError(500, 'Server is missing GH_TOKEN');
  return token;
}

function ghHeaders(extra) {
  return Object.assign(
    {
      Authorization: 'Bearer ' + requireToken(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rick-wolthusen-cms',
    },
    extra || {}
  );
}

function ghUrl(path) {
  const encoded = String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${API}/repos/${OWNER}/${REPO}/contents/${encoded}`;
}

/** Read a file from the repo. Returns null when it does not exist. */
async function ghGetFile(path, ref) {
  const res = await fetch(`${ghUrl(path)}?ref=${encodeURIComponent(ref || BRANCH)}`, {
    headers: ghHeaders(),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw httpError(502, `GitHub read failed (${res.status}) ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const buffer = Buffer.from(json.content || '', 'base64');
  return { sha: json.sha, buffer, text: buffer.toString('utf8'), size: json.size };
}

/** Create or update a file. Pass the current sha to update an existing file. */
async function ghPutFile(path, buffer, message, sha) {
  const body = {
    message,
    content: Buffer.from(buffer).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(ghUrl(path), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409) throw httpError(409, 'Someone else saved a newer version.');
    throw httpError(502, `GitHub write failed (${res.status}) ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Public, unauthenticated URL for a repo file (used to serve uploads). */
function rawUrl(path) {
  const encoded = String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${encoded}`;
}

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt' || !record.salt || !record.hash) return false;
  let expected;
  try {
    expected = Buffer.from(record.hash, 'base64');
  } catch (_) {
    return false;
  }
  const actual = crypto.scryptSync(String(password), Buffer.from(record.salt, 'base64'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ *
 * Admin store (encrypted at rest — the repository is public)
 * ------------------------------------------------------------------ */

function adminKey() {
  const secret = process.env.ADMIN_KEY;
  if (!secret) throw httpError(500, 'Server is missing ADMIN_KEY');
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptJSON(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', adminKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decryptJSON(text) {
  const box = JSON.parse(text);
  if (!box || box.v !== 1) throw httpError(500, 'Unrecognised admin store format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', adminKey(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

let adminsCache = { at: 0, file: null };

function invalidateAdminsCache() {
  adminsCache = { at: 0, file: null };
}

/** Returns { sha, data } or null when no admin file exists yet. */
async function loadAdmins(options) {
  const maxAge = (options && options.maxAge) || 0;
  if (adminsCache.file && Date.now() - adminsCache.at < maxAge) return adminsCache.file;
  const file = await ghGetFile(ADMINS_PATH);
  const parsed = file ? { sha: file.sha, data: decryptJSON(file.text) } : null;
  adminsCache = { at: Date.now(), file: parsed };
  return parsed;
}

async function saveAdmins(data, sha, message) {
  const buffer = Buffer.from(encryptJSON(data), 'utf8');
  const result = await ghPutFile(ADMINS_PATH, buffer, message || 'CMS: update admin accounts', sha);
  invalidateAdminsCache();
  return result;
}

function bootstrapCredentials() {
  return {
    username: process.env.BOOTSTRAP_ADMIN_USER || 'admin',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  };
}

function normaliseUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/**
 * When no admin file exists yet, the first matching bootstrap credential creates
 * one. This lets the very first sign-in work without committing anything secret.
 */
async function bootstrapAdmins(username, password) {
  const existing = await loadAdmins();
  if (existing) return existing;
  const boot = bootstrapCredentials();
  if (!boot.password) return null;
  if (normaliseUsername(username) !== normaliseUsername(boot.username)) return null;
  if (String(password) !== boot.password) return null;

  const data = {
    v: 1,
    createdAt: new Date().toISOString(),
    admins: [
      {
        username: normaliseUsername(boot.username),
        name: 'Administrator',
        email: '',
        role: 'super',
        createdAt: new Date().toISOString(),
        password: hashPassword(password),
      },
    ],
  };
  await saveAdmins(data, null, 'CMS: create initial admin account');
  return { sha: null, data };
}

/* ------------------------------------------------------------------ *
 * Sessions (stateless, HMAC-signed, httpOnly cookie)
 * ------------------------------------------------------------------ */

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw httpError(500, 'Server is missing SESSION_SECRET');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function createSession(user) {
  const payload = {
    u: normaliseUsername(user.username),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + sign(body);
}

function readSession(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || !payload.u || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (IS_PROD) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/**
 * Resolve the signed-in admin against the live admin store, so revoking or
 * downgrading an account takes effect on the very next request.
 */
async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const payload = readSession(token);
  if (!payload) return null;
  const store = await loadAdmins({ maxAge: 5000 });
  if (!store || !store.data || !Array.isArray(store.data.admins)) return null;
  const record = store.data.admins.find((a) => normaliseUsername(a.username) === payload.u);
  if (!record) return null;
  return {
    username: normaliseUsername(record.username),
    name: record.name || record.username,
    email: record.email || '',
    role: record.role === 'super' ? 'super' : 'editor',
  };
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw httpError(401, 'Please sign in.');
  return user;
}

async function requireSuper(req) {
  const user = await requireUser(req);
  if (user.role !== 'super') throw httpError(403, 'Only super admins can manage accounts.');
  return user;
}

/* ------------------------------------------------------------------ *
 * Request / response plumbing
 * ------------------------------------------------------------------ */

function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (headers) Object.keys(headers).forEach((k) => res.setHeader(k, headers[k]));
  res.end(payload);
}

function fail(res, error) {
  const status = (error && error.status) || 500;
  const message = status >= 500 ? (error && error.message) || 'Server error' : error.message;
  if (status >= 500) console.error('[cms]', error);
  send(res, status, { ok: false, error: message });
}

/**
 * Read the request body as bytes.
 *
 * The serverless runtime buffers most bodies for us: JSON as a parsed object,
 * anything it does not recognise as a Buffer. Some content types are dropped
 * outright, which is why uploads are sent as application/octet-stream. The
 * stream is read only when the runtime left it untouched.
 */
async function readRaw(req, limit) {
  const buffered = req.body;
  if (Buffer.isBuffer(buffered)) {
    if (buffered.length > limit) throw httpError(413, 'That file is too large.');
    return buffered;
  }
  if (typeof buffered === 'string') {
    const bytes = Buffer.from(buffered, 'binary');
    if (bytes.length > limit) throw httpError(413, 'That file is too large.');
    return bytes;
  }
  if (buffered != null && typeof buffered === 'object') {
    const bytes = Buffer.from(JSON.stringify(buffered), 'utf8');
    if (bytes.length > limit) throw httpError(413, 'That file is too large.');
    return bytes;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw httpError(413, 'That file is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJSON(req, limit) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRaw(req, limit || 2 * 1024 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    throw httpError(400, 'Expected a JSON body.');
  }
}

/** Blocks cross-site form posts; browsers send Origin on state-changing requests. */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch (_) {
    throw httpError(403, 'Bad request origin.');
  }
  const own = req.headers['x-forwarded-host'] || req.headers.host;
  if (own && host !== String(own).split(',')[0].trim()) throw httpError(403, 'Bad request origin.');
}

function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods.join(', '));
  return send(res, 405, { ok: false, error: 'Method not allowed' });
}

function publicAdmin(record) {
  return {
    username: normaliseUsername(record.username),
    name: record.name || '',
    email: record.email || '',
    role: record.role === 'super' ? 'super' : 'editor',
    createdAt: record.createdAt || '',
    createdBy: record.createdBy || '',
  };
}

module.exports = {
  OWNER,
  REPO,
  BRANCH,
  ADMINS_PATH,
  CONTENT_PATH,
  SESSION_COOKIE,
  httpError,
  ghGetFile,
  ghPutFile,
  rawUrl,
  hashPassword,
  verifyPassword,
  loadAdmins,
  saveAdmins,
  bootstrapAdmins,
  invalidateAdminsCache,
  createSession,
  currentUser,
  requireUser,
  requireSuper,
  setSessionCookie,
  clearSessionCookie,
  send,
  fail,
  readRaw,
  readJSON,
  assertSameOrigin,
  methodNotAllowed,
  normaliseUsername,
  publicAdmin,
};
