'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
const state = require('../lib/state');

test('stages are saved with history and survive a reload', () => {
  const s = state.load('com.x');
  state.setStage(s, 5, 'built', { sha: 'abc' });
  state.setStage(s, 5, 'testing');
  state.save('com.x', s);
  const again = state.load('com.x');
  assert.strictEqual(again.candidates[5].stage, 'testing');
  assert.strictEqual(again.candidates[5].history[0].sha, 'abc');
  assert.throws(() => state.setStage(again, 5, 'nonsense'), /unknown stage/);
});

test('lock is exclusive while held and free after release', () => {
  const release = state.lock('t');
  assert.ok(release);
  assert.strictEqual(state.lock('t'), null);
  release();
  const again = state.lock('t');
  assert.ok(again);
  again();
});

test('a lock left by a dead process is taken over', () => {
  const d = path.join(state.HOME, 'dead.lock');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'pid'), '999999');
  const release = state.lock('dead');
  assert.ok(release);
  release();
});

test('PAUSE files stop all apps or one app', () => {
  assert.strictEqual(state.paused('com.y'), false);
  fs.mkdirSync(path.join(state.HOME, 'com.y'), { recursive: true });
  fs.writeFileSync(path.join(state.HOME, 'com.y', 'PAUSE'), '');
  assert.strictEqual(state.paused('com.y'), true);
  assert.strictEqual(state.paused('com.z'), false);
});
