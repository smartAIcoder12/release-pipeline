// Google Play Android Publisher API v3, with no dependencies (Node 20+: fetch, crypto).
// Auth: a service account JSON key with access to the app in Play Console.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A signed JWT that Google swaps for an access token (RFC 7523). */
function jwtFor(sa, scope, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Reads the key from a file path or from JSON text (a CI secret). */
function loadServiceAccount(pathOrJson) {
  const text = pathOrJson.trim().startsWith('{') ? pathOrJson : fs.readFileSync(pathOrJson, 'utf8');
  const sa = JSON.parse(text);
  if (!sa.client_email || !sa.private_key) throw new Error('service account JSON has no client_email/private_key');
  return sa;
}

class PlayError extends Error {
  constructor(status, body) {
    const msg = body?.error?.message ?? JSON.stringify(body);
    super(`Play API ${status}: ${msg}`);
    this.status = status;
    this.body = body;
  }
}

function client(sa, scope = SCOPE) {
  let cached = null;
  async function token() {
    if (cached && cached.until > Date.now() + 60_000) return cached.value;
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtFor(sa, scope) }),
    });
    const body = await res.json();
    if (!res.ok) throw new PlayError(res.status, body);
    cached = { value: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return cached.value;
  }
  async function call(method, url, { json, data, contentType, raw } = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await token()}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(contentType ? { 'Content-Type': contentType } : {}) },
        body: json ? JSON.stringify(json) : data,
      });
      // Google asks clients to retry 429 and 5xx with backoff.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      if (raw && res.ok) return res;
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) throw new PlayError(res.status, body);
      return body;
    }
  }
  return { token, call };
}

/** Opens an edit, runs fn(editId), commits it. Any error deletes the edit, so nothing half-done is left. */
async function withEdit(c, pkg, fn, { changesNotSentForReview = false } = {}) {
  const { id } = await c.call('POST', `${API}/${pkg}/edits`, { json: {} });
  try {
    const result = await fn(id);
    const q = changesNotSentForReview ? '?changesNotSentForReview=true' : '';
    await c.call('POST', `${API}/${pkg}/edits/${id}:commit${q}`);
    return result;
  } catch (e) {
    await c.call('DELETE', `${API}/${pkg}/edits/${id}`).catch(() => {});
    throw e;
  }
}

/** Highest versionCode Play has seen for the app (uploaded bundles and every track). */
async function maxVersionCode(c, pkg) {
  const { id } = await c.call('POST', `${API}/${pkg}/edits`, { json: {} });
  try {
    const bundles = await c.call('GET', `${API}/${pkg}/edits/${id}/bundles`);
    const tracks = await c.call('GET', `${API}/${pkg}/edits/${id}/tracks`);
    return highestCode(bundles.bundles ?? [], tracks.tracks ?? []);
  } finally {
    await c.call('DELETE', `${API}/${pkg}/edits/${id}`).catch(() => {});
  }
}

function highestCode(bundles, tracks) {
  const codes = [
    ...bundles.map((b) => Number(b.versionCode)),
    ...tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number))),
  ].filter(Number.isFinite);
  return codes.length ? Math.max(...codes) : 0;
}

async function getTracks(c, pkg) {
  const { id } = await c.call('POST', `${API}/${pkg}/edits`, { json: {} });
  try {
    return (await c.call('GET', `${API}/${pkg}/edits/${id}/tracks`)).tracks ?? [];
  } finally {
    await c.call('DELETE', `${API}/${pkg}/edits/${id}`).catch(() => {});
  }
}

/**
 * The release object for one versionCode on a track. A Play app that has never been published only
 * accepts draft releases; `status` is passed through and Play's error explains if it is refused.
 */
function releaseFor(versionCode, { status = 'completed', userFraction, name, notes } = {}) {
  const r = { versionCodes: [String(versionCode)], status };
  if (name) r.name = name;
  if (status === 'inProgress' || status === 'halted') {
    if (!(userFraction > 0 && userFraction < 1)) throw new Error(`${status} needs a userFraction between 0 and 1`);
    r.userFraction = userFraction;
  }
  if (notes) r.releaseNotes = [{ language: 'en-US', text: notes.slice(0, 500) }];
  return r;
}

/** Uploads an AAB and puts it on a track in one edit. Returns the versionCode Play read from it. */
async function uploadBundle(c, pkg, aabPath, { track = 'internal', status = 'completed', name, notes } = {}) {
  return withEdit(c, pkg, async (editId) => {
    const bundle = await c.call('POST', `${UPLOAD}/${pkg}/edits/${editId}/bundles?uploadType=media`, { data: fs.readFileSync(aabPath), contentType: 'application/octet-stream' });
    const code = Number(bundle.versionCode);
    await c.call('PUT', `${API}/${pkg}/edits/${editId}/tracks/${track}`, { json: { track, releases: [releaseFor(code, { status, name, notes })] } });
    return code;
  });
}

/** Puts an already uploaded versionCode on a track (no rebuild, no new upload). */
async function setRelease(c, pkg, track, versionCode, opts = {}) {
  return withEdit(c, pkg, (editId) => c.call('PUT', `${API}/${pkg}/edits/${editId}/tracks/${track}`, { json: { track, releases: [releaseFor(versionCode, opts)] } }));
}

/** Play-signed universal APK for a versionCode: the same signature users get from the store. */
async function downloadUniversalApk(c, pkg, versionCode, outPath) {
  const list = await c.call('GET', `${API}/${pkg}/generatedApks/${versionCode}`);
  const universal = (list.generatedApks ?? []).map((g) => g.generatedUniversalApk).find(Boolean);
  if (!universal) throw new Error(`Play has no universal APK for versionCode ${versionCode} yet`);
  // About 70 MB, and Google's download server is slow at times: stream to disk and retry a dropped connection.
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await c.call('GET', `${API}/${pkg}/generatedApks/${versionCode}/downloads/${universal.downloadId}:download?alt=media`, { raw: true });
      const tmp = `${outPath}.part`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const want = Number(res.headers.get('content-length'));
      if (want && fs.statSync(tmp).size !== want) throw new Error(`download cut short (${fs.statSync(tmp).size} of ${want} bytes)`);
      fs.renameSync(tmp, outPath);
      return outPath;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

module.exports = { jwtFor, loadServiceAccount, client, withEdit, maxVersionCode, highestCode, getTracks, releaseFor, uploadBundle, setRelease, downloadUniversalApk, PlayError };
