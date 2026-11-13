'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rateFor } = require('../lib/vitals');
const { newestOn, failedFlows } = require('../lib/runner');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const row = (code, rate, users) => ({ dimensions: [{ dimension: 'versionCode', stringValue: String(code) }], metrics: [{ metric: 'crashRate', decimalValue: { value: String(rate) } }, { metric: 'distinctUsers', decimalValue: { value: String(users) } }] });

test('rateFor weights days by users and ignores other versions', () => {
  assert.deepStrictEqual(rateFor([], 5), { rate: null, users: 0 });
  const r = rateFor([row(5, 0.01, 100), row(5, 0.03, 100), row(4, 0.9, 1000)], 5);
  assert.strictEqual(r.users, 200);
  assert.ok(Math.abs(r.rate - 0.02) < 1e-9);
});

test('newestOn picks the highest versionCode on a track', () => {
  assert.strictEqual(newestOn([{ track: 'internal', releases: [{ versionCodes: ['5'] }, { versionCodes: ['7'] }] }], 'internal'), 7);
  assert.strictEqual(newestOn([{ track: 'internal' }], 'internal'), null);
  assert.strictEqual(newestOn([], 'internal'), null);
});

test('failedFlows reads failed test cases from the JUnit report', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'r.xml');
  fs.writeFileSync(f, '<testsuite><testcase name="01-home" time="3"/><testcase name="02-tools" time="9"><failure message="Element not found: tool-cma"/></testcase></testsuite>');
  assert.deepStrictEqual(failedFlows(f), ['02-tools: Element not found: tool-cma']);
  assert.deepStrictEqual(failedFlows(f + '.missing'), ['(no report: Maestro did not run)']);
});

const { failStreak, sameFailureTwice, loadConfig, shaOf } = require('../lib/runner');
const cand = (code, stage, problems) => ({ code, stage, history: [{ stage, problems }] });

test('failStreak counts failed candidates back to the last good one, skipping superseded ones', () => {
  const s = { candidates: { 3: cand(3, 'released'), 4: cand(4, 'failed'), 5: cand(5, 'superseded'), 6: cand(6, 'failed') } };
  assert.strictEqual(failStreak(s), 2);
  assert.strictEqual(failStreak({ candidates: { 3: cand(3, 'tested') } }), 0);
});

test('sameFailureTwice compares the problems of the last two failures', () => {
  assert.strictEqual(sameFailureTwice({ candidates: { 4: cand(4, 'failed', ['a', 'b']), 5: cand(5, 'failed', ['b', 'a']) } }), true);
  assert.strictEqual(sameFailureTwice({ candidates: { 4: cand(4, 'failed', ['a']), 5: cand(5, 'failed', ['c']) } }), false);
});

test('loadConfig fills nested defaults and the app folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const f = path.join(dir, 'pipeline.json');
  fs.writeFileSync(f, JSON.stringify({ package: 'com.x', device: 'd', serviceAccount: 'k.json', fix: { enabled: true } }));
  const c = loadConfig(f);
  assert.strictEqual(c.fix.maxAttempts, 3);
  assert.strictEqual(c.fix.enabled, true);
  assert.strictEqual(c.appDir, dir);
});

test('shaOf reads the commit from the CI release name', () => {
  assert.strictEqual(shaOf([{ track: 'internal', releases: [{ name: '5 (d1a9cc4)', versionCodes: ['5'] }] }], 5), 'd1a9cc4');
  assert.strictEqual(shaOf([{ track: 'internal', releases: [{ name: '1.0.0', versionCodes: ['4'] }] }], 4), null);
});
