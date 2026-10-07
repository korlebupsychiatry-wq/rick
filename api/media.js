'use strict';

const {
  rawUrl,
  ghListDir,
  ghGetFile,
  ghDeleteFile,
  requireUser,
  readJSON,
  assertSameOrigin,
  send,
  fail,
  methodNotAllowed,
  httpError,
  CONTENT_PATH,
} = require('./_lib');

/**
 * Serves uploaded media straight from the repository's public CDN, and backs the
 * studio's media library.
 *
 * Only the uploads/ prefix is reachable — the repo also holds files that must
 * never be served (the encrypted admin store, source documents), so anything
 * else is refused rather than proxied.
 */
const ALLOWED = /^uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MAX_LISTED = 400;

/** Every string in the content document that looks like an upload path. */
function referencedPaths(value, out) {
  const found = out || new Set();
  if (typeof value === 'string') {
    const matches = value.match(/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}/g);
    if (matches) matches.forEach((match) => found.add(match));
  } else if (Array.isArray(value)) {
    value.forEach((entry) => referencedPaths(entry, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => referencedPaths(entry, found));
  }
  return found;
}

async function listUploads() {
  // Two kinds of picture live in the repository: the curated originals that ship
  // with the site, and whatever has been uploaded since. Both are offered for
  // reuse; only uploads can be removed from here.
  const [curated, uploaded] = await Promise.all([ghListDir('images'), ghListDir('uploads')]);
  const shape = (kind) => (file) => ({
    path: file.path,
    name: file.name,
    size: file.size || 0,
    kind,
    url: rawUrl(file.path),
  });
  return {
    curated: curated.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LISTED).map(shape('curated')),
    uploaded: uploaded.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LISTED).map(shape('uploaded')),
  };
}

async function deleteUpload(req, res, user, body) {
  assertSameOrigin(req);
  const path = String(body.path || '').replace(/\\/g, '/').trim();
  if (!ALLOWED.test(path)) throw httpError(400, 'That file cannot be managed from here.');

  // An editor may only remove images the site no longer uses: deleting one that
  // is still on the page would break the published site, and that call is the
  // super admin's to make.
  if (user.role !== 'super') {
    const content = await ghGetFile(CONTENT_PATH);
    const inUse = content ? referencedPaths(content.text) : new Set();
    if (inUse.has(path)) {
      throw httpError(
        403,
        'That image is still used on the site. Remove it from the section that uses it first, or ask a super admin.'
      );
    }
  }

  const file = await ghGetFile(path);
  if (!file) throw httpError(404, 'That file no longer exists.');
  await ghDeleteFile(path, `CMS: delete ${path.split('/').pop()} (${user.username})`, file.sha);
  return send(res, 200, { ok: true, deleted: path });
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.searchParams.get('list')) {
        await requireUser(req);
        return send(res, 200, Object.assign({ ok: true }, await listUploads()));
      }

      const path = (url.searchParams.get('path') || '').replace(/\\/g, '/').trim();
      if (!ALLOWED.test(path)) throw httpError(404, 'Not found');

      res.statusCode = 301;
      res.setHeader('Location', rawUrl(path));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end();
      return undefined;
    } catch (error) {
      return fail(res, error);
    }
  }

  if (req.method === 'POST') {
    try {
      const user = await requireUser(req);
      const body = await readJSON(req, 8 * 1024);
      if (String(body.action || '') === 'delete') return await deleteUpload(req, res, user, body);
      throw httpError(400, 'Unknown action.');
    } catch (error) {
      return fail(res, error);
    }
  }

  return methodNotAllowed(res, ['GET', 'HEAD', 'POST']);
};
