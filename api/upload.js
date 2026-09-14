'use strict';

const crypto = require('crypto');
const {
  ghGetFile,
  ghPutFile,
  requireUser,
  readRaw,
  assertSameOrigin,
  send,
  fail,
  methodNotAllowed,
  httpError,
} = require('./_lib');

const MAX_BYTES = 4.4 * 1024 * 1024;

const TYPE_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * Trust the bytes rather than the label. Uploads arrive as
 * application/octet-stream (the runtime drops some image content types), so
 * the declared type is only a fallback.
 */
function sniff(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'image';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    assertSameOrigin(req);
    const user = await requireUser(req);

    const url = new URL(req.url, 'http://localhost');
    const original = url.searchParams.get('name') || req.headers['x-filename'] || '';
    const declared = String(url.searchParams.get('type') || req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    const buffer = await readRaw(req, MAX_BYTES);
    if (!buffer.length) throw httpError(400, 'The upload arrived empty — please try again.');

    const ext = sniff(buffer) || TYPE_EXT[declared];
    if (!ext) throw httpError(415, 'Only JPEG, PNG, WebP, GIF or AVIF images can be uploaded.');

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const path = `uploads/${slugify(decodeURIComponent(original))}-${hash}.${ext}`;

    const existing = await ghGetFile(path);
    if (!existing) {
      await ghPutFile(path, buffer, `CMS: upload ${path.split('/').pop()} (${user.username})`, null);
    }

    return send(res, 200, {
      ok: true,
      path,
      deduplicated: !!existing,
      bytes: buffer.length,
      url: '/api/media?path=' + encodeURIComponent(path),
    });
  } catch (error) {
    return fail(res, error);
  }
};
