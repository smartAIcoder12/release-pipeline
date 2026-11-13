'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findCrashes } = require('../lib/device');

test('findCrashes keeps only crashes of the app under test', () => {
  const log = [
    'E AndroidRuntime: FATAL EXCEPTION: main',
    'E AndroidRuntime: Process: com.other.app, PID: 1',
    'E AndroidRuntime: FATAL EXCEPTION: main',
    'E AndroidRuntime: Process: com.listsoeasy.app, PID: 2',
    'E ReactNativeJS: Unhandled JS Exception: TypeError: x is undefined',
    'E ReactNativeJS: [RevenueCat] Error fetching offerings',
  ].join('\n');
  const found = findCrashes(log, 'com.listsoeasy.app');
  assert.strictEqual(found.length, 2);
  assert.match(found[0], /com\.listsoeasy\.app/);
  assert.match(found[1], /Unhandled JS Exception/);
});
