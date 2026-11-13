'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const play = require('../lib/play');

test('jwtFor signs a token Google can verify with the public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const jwt = play.jwtFor({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey }, 'scope-x', 1000);
  const [h, b, s] = jwt.split('.');
  const body = JSON.parse(Buffer.from(b, 'base64url'));
  assert.deepStrictEqual(body, { iss: 'a@b.iam.gserviceaccount.com', scope: 'scope-x', aud: 'https://oauth2.googleapis.com/token', iat: 1000, exp: 4600 });
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('highestCode looks at uploaded bundles and every track', () => {
  assert.strictEqual(play.highestCode([], []), 0);
  assert.strictEqual(play.highestCode([{ versionCode: 3 }], [{ track: 'production', releases: [{ versionCodes: ['4'] }] }, { track: 'internal', releases: [{}] }]), 4);
});

test('releaseFor needs a fraction for a staged rollout and drops it otherwise', () => {
  assert.deepStrictEqual(play.releaseFor(7), { versionCodes: ['7'], status: 'completed' });
  assert.deepStrictEqual(play.releaseFor(7, { status: 'inProgress', userFraction: 0.1 }), { versionCodes: ['7'], status: 'inProgress', userFraction: 0.1 });
  assert.throws(() => play.releaseFor(7, { status: 'inProgress' }), /userFraction/);
  assert.throws(() => play.releaseFor(7, { status: 'inProgress', userFraction: 1 }), /userFraction/);
});

test('loadServiceAccount takes JSON text or refuses a key without its fields', () => {
  assert.strictEqual(play.loadServiceAccount('{"client_email":"x","private_key":"y"}').client_email, 'x');
  assert.throws(() => play.loadServiceAccount('{"client_email":"x"}'), /private_key/);
});
