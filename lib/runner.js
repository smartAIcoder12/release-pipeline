// The Mac side of the pipeline. `tick` runs every few minutes (launchd) and moves each app's newest
// candidate one step further. All decisions are made here, in code; Claude is only called to test a
// new feature by hand and to fix a failure, and its verdict alone never releases anything.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const play = require('./play');
const device = require('./device');
const state = require('./state');
const notify = require('./notify');
const claude = require('./claude');

const MAESTRO = process.env.MAESTRO || path.join(os.homedir(), '.maestro/bin/maestro');

/** pipeline.json in the app repo, plus the defaults. */
function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['package', 'device', 'serviceAccount']) if (!cfg[k]) throw new Error(`${file}: missing "${k}"`);
  const defaults = {
    candidateTrack: 'internal',
    flows: ['e2e/smoke', 'e2e/features'],
    seed: null,
    fix: { enabled: false, maxAttempts: 3 },
    explore: { enabled: false },
    release: { track: 'production', stages: [0.1, 0.5, 1], hoursBetween: 24, approve: 'always', maxCrashRate: 0.01 },
  };
  const out = { ...defaults, appDir: path.dirname(path.resolve(file)), ...cfg, file: path.resolve(file) };
  // One level deep, so { "fix": { "enabled": true } } keeps the default maxAttempts.
  for (const k of ['fix', 'explore', 'release']) out[k] = { ...defaults[k], ...cfg[k] };
  return out;
}

/** The commit a versionCode was built from: CI names each release "<code> (<sha7>)". */
function shaOf(tracks, code) {
  for (const t of tracks) for (const r of t.releases ?? []) if ((r.versionCodes ?? []).map(Number).includes(code)) return /\(([0-9a-f]{7,40})\)/.exec(r.name ?? '')?.[1] ?? null;
  return null;
}

function newestOn(tracks, name) {
  const t = tracks.find((x) => x.track === name);
  const codes = (t?.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number));
  return codes.length ? Math.max(...codes) : null;
}

/** Runs every flow folder on the phone. Returns { ok, failures[] }. Retries a failed run once to tell flaky from broken. */
function runFlows(cfg, dir) {
  const folders = cfg.flows.map((f) => path.join(cfg.appDir, f)).filter((f) => fs.existsSync(f) && fs.readdirSync(f).some((x) => x.endsWith('.yaml')));
  const run = (attempt) => {
    const out = path.join(dir, `maestro-${attempt}`);
    const r = spawnSync(MAESTRO, ['--device', cfg.device, 'test', ...folders, '--format', 'JUNIT', '--output', path.join(out, 'report.xml'), '--test-output-dir', out], { encoding: 'utf8', timeout: 30 * 60_000 });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'stdout.txt'), (r.stdout ?? '') + (r.stderr ?? ''));
    return { ok: r.status === 0, failures: failedFlows(path.join(out, 'report.xml')) };
  };
  const first = run(1);
  if (first.ok) return first;
  const second = run(2);
  return { ok: second.ok, flaky: second.ok, failures: second.ok ? first.failures : second.failures };
}

function failedFlows(reportXml) {
  if (!fs.existsSync(reportXml)) return ['(no report: Maestro did not run)'];
  const xml = fs.readFileSync(reportXml, 'utf8');
  return [...xml.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*>\s*<failure([^>]*)>/g)].map((m) => {
    const msg = /message="([^"]*)"/.exec(m[2])?.[1];
    return msg ? `${m[1]}: ${msg}` : m[1];
  });
}

/** The phone part of a test: download, install over the current app, seed, run flows, check crashes. */
async function phoneTest(cfg, code) {
  const dir = state.runDir(cfg.package, code);
  const apk = path.join(dir, `app-${code}.apk`);
  const problems = device.preflight(cfg.device);
  if (problems.length) return { env: true, problems };
  if (!fs.existsSync(apk)) await play.downloadUniversalApk(play.client(play.loadServiceAccount(cfg.serviceAccount)), cfg.package, code, apk);
  device.prepare(cfg.device);
  device.installUpgrade(cfg.device, apk);
  if (device.installedVersionCode(cfg.device, cfg.package) !== code) return { env: false, problems: [`install did not take: phone has versionCode ${device.installedVersionCode(cfg.device, cfg.package)}`] };
  if (cfg.seed) execFileSync('/bin/zsh', ['-c', cfg.seed], { cwd: cfg.appDir, stdio: 'inherit', timeout: 120_000 });
  device.clearLogs(cfg.device);
  const flows = runFlows(cfg, dir);
  const crashes = device.crashes(cfg.device, cfg.package);
  device.saveLogcat(cfg.device, path.join(dir, 'logcat.txt'));
  const failures = [...flows.failures.map((f) => `flow ${f}`), ...crashes.map((c) => `crash: ${c.split('\n')[0]}`)];
  return { env: false, ok: flows.ok && crashes.length === 0, flaky: flows.flaky, problems: failures, dir };
}

async function tick(cfg, { log = console.log } = {}) {
  if (state.paused(cfg.package)) return log(`${cfg.package}: paused`);
  const release = state.lock(cfg.package);
  if (!release) return log(`${cfg.package}: another tick is running`);
  try {
    const c = play.client(play.loadServiceAccount(cfg.serviceAccount));
    const tracks = await play.getTracks(c, cfg.package);
    const s = state.load(cfg.package);
    const code = newestOn(tracks, cfg.candidateTrack);
    if (code && !s.candidates[code]) {
      for (const old of Object.values(s.candidates)) if (['built', 'tested', 'failed', 'env-blocked'].includes(old.stage)) state.setStage(s, old.code, 'superseded', { by: code });
      state.setStage(s, code, 'built', { sha: shaOf(tracks, code) });
    }
    state.save(cfg.package, s);
    for (const cand of Object.values(s.candidates).sort((a, b) => b.code - a.code)) {
      // A test that died with the Mac or the process (no update for 45 min) starts again.
      const stuck = cand.stage === 'testing' && Date.now() - Date.parse(cand.history.at(-1).at) > 45 * 60_000;
      if (['built', 'env-blocked'].includes(cand.stage) || stuck) await testStep(cfg, s, cand, log);
      else if (cand.stage === 'tested' || cand.stage === 'approved') await releaseStep(cfg, s, cand, c, log);
      else if (cand.stage === 'rollout') await rolloutStep(cfg, s, cand, c, log);
      state.save(cfg.package, s);
    }
  } finally {
    release();
  }
}

async function testStep(cfg, s, cand, log) {
  state.setStage(s, cand.code, 'testing');
  state.save(cfg.package, s);
  log(`${cfg.package} ${cand.code}: testing on ${cfg.device}`);
  let r;
  try {
    r = await phoneTest(cfg, cand.code);
  } catch (e) {
    r = { env: true, problems: [e.message] };
  }
  if (r.env) {
    state.setStage(s, cand.code, 'env-blocked', { problems: r.problems });
    return notify.send(cfg, `${cand.code}: test could not run`, r.problems.join('; '));
  }
  if (r.ok) {
    let explore = null;
    const sha = cand.history[0]?.sha;
    const base = lastReleasedSha(s);
    if (cfg.explore.enabled && sha && base && base !== sha) {
      const report = claude.explore(cfg, cand.code, base, sha, r.dir);
      explore = claude.verdict(report);
    }
    state.setStage(s, cand.code, 'tested', { flaky: !!r.flaky, dir: r.dir, explore });
    const extra = explore === 'problems' ? ' The hands-on test reported problems: read explore.md before approving.' : '';
    return notify.send(cfg, `${cand.code}: phone tests passed`, (r.flaky ? 'passed on the second try (flaky flow).' : 'all flows passed.') + extra);
  }
  state.setStage(s, cand.code, 'failed', { problems: r.problems, dir: r.dir });
  const streak = failStreak(s);
  notify.send(cfg, `${cand.code}: phone tests FAILED`, r.problems.slice(0, 3).join('; '));
  if (!cfg.fix.enabled) return;
  if (streak > cfg.fix.maxAttempts) return notify.send(cfg, `${cand.code}: not fixing again`, `${streak} failed candidates in a row; a person needs to look`);
  if (sameFailureTwice(s)) return notify.send(cfg, `${cand.code}: same failure twice`, 'the last fix did not work; a person needs to look');
  claude.startFix(cfg, cand.code, r, cand.history[0]?.sha);
  notify.send(cfg, `${cand.code}: fixing`, `attempt ${streak} of ${cfg.fix.maxAttempts}`);
}

/** Failed candidates since the last one that passed or shipped (newest first). */
function failStreak(s) {
  let n = 0;
  for (const c of Object.values(s.candidates).sort((a, b) => b.code - a.code)) {
    if (c.stage === 'failed') n++;
    else if (c.stage !== 'superseded') break;
  }
  return n;
}

function sameFailureTwice(s) {
  const failed = Object.values(s.candidates).filter((c) => c.stage === 'failed').sort((a, b) => b.code - a.code);
  if (failed.length < 2) return false;
  const key = (c) => JSON.stringify((c.history.at(-1).problems ?? []).slice().sort());
  return key(failed[0]) === key(failed[1]);
}

function lastReleasedSha(s) {
  const done = Object.values(s.candidates).filter((c) => ['released', 'rollout'].includes(c.stage)).sort((a, b) => b.code - a.code)[0];
  return done?.history[0]?.sha ?? null;
}

async function releaseStep(cfg, s, cand, c, log) {
  const rel = cfg.release;
  if (cand.stage === 'tested' && rel.approve === 'always') {
    if (!cand.approvalAsked) {
      cand.approvalAsked = true;
      notify.send(cfg, `${cand.code}: ready for production`, `Approve with: rp approve --config ${cfg.file} --code ${cand.code}`);
    }
    return;
  }
  const first = rel.stages[0];
  try {
    await play.setRelease(c, cfg.package, rel.track, cand.code, first >= 1 ? { status: 'completed' } : { status: 'inProgress', userFraction: first });
  } catch (e) {
    state.setStage(s, cand.code, 'halted', { problems: [e.message] });
    return notify.send(cfg, `${cand.code}: production upload refused`, e.message);
  }
  state.setStage(s, cand.code, first >= 1 ? 'released' : 'rollout', { fraction: first });
  notify.send(cfg, `${cand.code}: sent to ${rel.track}`, first >= 1 ? 'full release (Google reviews it first)' : `staged rollout ${first * 100}% (Google reviews it first)`);
  log(`${cfg.package} ${cand.code}: released to ${rel.track}`);
}

async function rolloutStep(cfg, s, cand, c, log) {
  const rel = cfg.release;
  const last = cand.history.at(-1);
  if (Date.now() - Date.parse(last.at) < rel.hoursBetween * 3600_000) return;
  const vitals = await require('./vitals').crashRate(cfg, cand.code).catch((e) => ({ error: e.message }));
  if (vitals.error || vitals.rate == null) return notify.once(cfg, cand, 'vitals', `${cand.code}: no crash data`, `Rollout held at ${last.fraction * 100}%: ${vitals.error ?? 'Play has no crash rate yet'}`);
  if (vitals.rate > rel.maxCrashRate) {
    await play.setRelease(c, cfg.package, rel.track, cand.code, { status: 'halted', userFraction: last.fraction });
    state.setStage(s, cand.code, 'halted', { problems: [`crash rate ${vitals.rate}`] });
    return notify.send(cfg, `${cand.code}: rollout HALTED`, `crash rate ${(vitals.rate * 100).toFixed(2)}% > ${rel.maxCrashRate * 100}%`);
  }
  const next = rel.stages.find((f) => f > last.fraction) ?? 1;
  await play.setRelease(c, cfg.package, rel.track, cand.code, next >= 1 ? { status: 'completed' } : { status: 'inProgress', userFraction: next });
  state.setStage(s, cand.code, next >= 1 ? 'released' : 'rollout', { fraction: next, crashRate: vitals.rate });
  notify.send(cfg, `${cand.code}: rollout ${next * 100}%`, `crash rate ${(vitals.rate * 100).toFixed(2)}%`);
  log(`${cfg.package} ${cand.code}: rollout ${next}`);
}

module.exports = { loadConfig, tick, phoneTest, newestOn, shaOf, failedFlows, failStreak, sameFailureTwice };
