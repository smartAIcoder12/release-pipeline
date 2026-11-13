// The test phone, over adb. Every call names the serial, so a second phone on the Mac changes nothing.
'use strict';
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const ADB = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb');

function adb(serial, args, { timeout = 120_000, allowFail = false } = {}) {
  try {
    return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`adb ${args.join(' ')}: ${(e.stderr || e.message).toString().trim().split('\n').pop()}`);
  }
}

/**
 * Checks the phone is fit for a test run. A failure here is an environment problem, never an app bug:
 * the runner reports it and does not try to "fix" the app.
 */
function preflight(serial, { minBattery = 20, pingHost = 'play.googleapis.com' } = {}) {
  const problems = [];
  if (adb(serial, ['get-state'], { allowFail: true }) !== 'device') return [`phone ${serial} is not connected (USB) or not authorised for adb`];
  const battery = Number(/level: (\d+)/.exec(adb(serial, ['shell', 'dumpsys', 'battery']) ?? '')?.[1]);
  if (!(battery >= minBattery)) problems.push(`battery ${battery}% (< ${minBattery}%)`);
  if (adb(serial, ['shell', 'ping', '-c', '1', '-W', '5', pingHost], { allowFail: true }) === null) problems.push(`no internet on the phone (ping ${pingHost} failed)`);
  return problems;
}

/** Keeps the screen on while plugged in and turns animations off, so UI tests are stable. */
function prepare(serial) {
  adb(serial, ['shell', 'svc', 'power', 'stayon', 'true']);
  for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) adb(serial, ['shell', 'settings', 'put', 'global', k, '0']);
  adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(serial, ['shell', 'wm', 'dismiss-keyguard'], { allowFail: true });
}

function installedVersionCode(serial, pkg) {
  const out = adb(serial, ['shell', 'dumpsys', 'package', pkg], { allowFail: true }) ?? '';
  const m = /versionCode=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

/** Fresh install: removes the app and its data first. */
function installFresh(serial, pkg, apk) {
  adb(serial, ['uninstall', pkg], { allowFail: true });
  adb(serial, ['install', apk], { timeout: 300_000 });
}

/** Upgrade over the installed app, keeping its data (what users get from the store). */
function installUpgrade(serial, apk) {
  try {
    adb(serial, ['install', '-r', apk], { timeout: 300_000 });
  } catch (e) {
    // The phone has a build signed with another key (a local build with the upload key, not Play's).
    // Upgrading is impossible; uninstalling would sign the test account out. A person does it once.
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(e.message)) throw Object.assign(new Error(`the installed app is signed with another key; uninstall it once on ${serial}, install the Play build and sign in`), { env: true });
    throw e;
  }
}

function clearLogs(serial) {
  adb(serial, ['logcat', '-c'], { allowFail: true });
  adb(serial, ['logcat', '-b', 'crash', '-c'], { allowFail: true });
}

/** Crashes of the app since the last clearLogs: native or Java, plus React Native fatal JS errors. */
function crashes(serial, pkg) {
  const crash = adb(serial, ['logcat', '-d', '-b', 'crash'], { allowFail: true }) ?? '';
  const main = adb(serial, ['logcat', '-d', '*:E'], { allowFail: true }) ?? '';
  return findCrashes(crash + '\n' + main, pkg);
}

function findCrashes(log, pkg) {
  const lines = log.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if ((/FATAL EXCEPTION/.test(l) && lines.slice(i, i + 3).some((x) => x.includes(pkg))) || /ReactNativeJS.*(Fatal|Unhandled JS Exception)/.test(l)) out.push(lines.slice(i, i + 8).join('\n'));
  });
  return out;
}

function saveLogcat(serial, file) {
  require('node:fs').writeFileSync(file, adb(serial, ['logcat', '-d'], { allowFail: true }) ?? '');
}

module.exports = { adb, preflight, prepare, installedVersionCode, installFresh, installUpgrade, clearLogs, crashes, findCrashes, saveLogcat, ADB };
