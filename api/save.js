'use strict';

const {
  ghGetFile,
  ghPutFile,
  CONTENT_PATH,
  requireUser,
  readJSON,
  assertSameOrigin,
  send,
  fail,
  methodNotAllowed,
  httpError,
} = require('./_lib');

const REQUIRED_SECTIONS = ['hero', 'stats', 'about', 'services', 'media', 'publications', 'recognition', 'gallery', 'contact'];
const MAX_BYTES = 900 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    assertSameOrigin(req);
    const user = await requireUser(req);
    const body = await readJSON(req, 2 * 1024 * 1024);

    const content = body.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw httpError(400, 'Missing content payload.');
    }
    for (const key of REQUIRED_SECTIONS) {
      if (!content[key] || typeof content[key] !== 'object') {
        throw httpError(400, `Section "${key}" is missing from the payload.`);
      }
    }

    content.version = Number(content.version) || 1;
    content.updatedAt = new Date().toISOString();
    content.updatedBy = user.username;

    const serialised = JSON.stringify(content, null, 2) + '\n';
    if (Buffer.byteLength(serialised, 'utf8') > MAX_BYTES) {
      throw httpError(413, 'The content is too large to save.');
    }

    const existing = await ghGetFile(CONTENT_PATH);
    if (existing && body.sha && existing.sha !== body.sha) {
      throw httpError(409, 'A newer version was saved by someone else. Reload to see it.');
    }

    const result = await ghPutFile(
      CONTENT_PATH,
      Buffer.from(serialised, 'utf8'),
      `CMS: content update by ${user.username}`,
      existing ? existing.sha : null
    );

    return send(res, 200, {
      ok: true,
      sha: (result && result.content && result.content.sha) || null,
      updatedAt: content.updatedAt,
      updatedBy: content.updatedBy,
    });
  } catch (error) {
    if (error && error.status === 409) {
      return send(res, 409, { ok: false, error: error.message, conflict: true });
    }
    return fail(res, error);
  }
};
