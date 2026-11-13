#!/usr/bin/env node
// release-pipeline CLI. Service account: --key <file> or env PLAY_SERVICE_ACCOUNT (file path or JSON).
//
//   rp next-code   --package <pkg>                        prints max versionCode on Play + 1
//   rp upload      --package <pkg> --aab <file> [--track internal] [--status completed|draft] [--name ..] [--notes ..]
//   rp release     --package <pkg> --code <n> --track production [--status completed|inProgress|halted|draft] [--fraction 0.1]
//   rp tracks      --package <pkg>                        prints every track's releases as JSON
//   rp apk         --package <pkg> --code <n> --out <file> downloads the Play-signed universal APK
//
// Mac runner (config = the app's pipeline.json):
//   rp tick        --config <file>    move the newest candidate one step (launchd runs this)
//   rp tick-all                       tick every app listed in ~/.release-pipeline/apps.txt
//   rp status      --config <file>    every candidate and its stage
//   rp approve     --config <file> --code <n>   allow this tested candidate to go to production
//   rp retest      --config <file> --code <n>   test this candidate again (after an env problem)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const play = require('../lib/play');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const need = (a, k) => {
  if (a[k] === undefined || a[k] === true) throw new Error(`missing --${k}`);
  return a[k];
};

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  // launchd starts node itself (macOS lets a granted node read the external disk, not /bin/zsh).
  // The phone is shared with other test runs, so tick-all re-runs itself inside the Mac's e2e lock.
  const lock = path.join(require('node:os').homedir(), '.claude/bin/e2e-lock');
  if (cmd === 'tick-all' && process.env.E2E_LOCK_HELD !== '1' && fs.existsSync(lock)) {
    process.exitCode = require('node:child_process').spawnSync(lock, ['--', `"${process.execPath}" "${__filename}" tick-all`], { stdio: 'inherit' }).status ?? 1;
    return;
  }
  if (['tick', 'tick-all', 'status', 'approve', 'retest'].includes(cmd)) return runnerCommand(cmd, a);
  const key = a.key || process.env.PLAY_SERVICE_ACCOUNT;
  if (!key) throw new Error('set --key or PLAY_SERVICE_ACCOUNT');
  const c = play.client(play.loadServiceAccount(key));
  const pkg = need(a, 'package');
  switch (cmd) {
    case 'next-code':
      console.log((await play.maxVersionCode(c, pkg)) + 1);
      break;
    case 'upload':
      console.log(await play.uploadBundle(c, pkg, need(a, 'aab'), { track: a.track || 'internal', status: a.status || 'completed', name: a.name, notes: a.notes }));
      break;
    case 'release':
      await play.setRelease(c, pkg, need(a, 'track'), Number(need(a, 'code')), { status: a.status || 'completed', userFraction: a.fraction ? Number(a.fraction) : undefined, name: a.name });
      console.log('ok');
      break;
    case 'tracks':
      console.log(JSON.stringify(await play.getTracks(c, pkg), null, 1));
      break;
    case 'apk':
      console.log(await play.downloadUniversalApk(c, pkg, Number(need(a, 'code')), need(a, 'out')));
      break;
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
}

async function runnerCommand(cmd, a) {
  const runner = require('../lib/runner');
  const state = require('../lib/state');
  if (cmd === 'tick-all') {
    const list = path.join(state.HOME, 'apps.txt');
    const files = fs.existsSync(list) ? fs.readFileSync(list, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
    for (const f of files) {
      try {
        await runner.tick(runner.loadConfig(f), { log: (m) => console.log(new Date().toISOString(), m) });
      } catch (e) {
        console.error(new Date().toISOString(), f, e.message);
      }
    }
    return;
  }
  const cfg = runner.loadConfig(need(a, 'config'));
  if (cmd === 'tick') return runner.tick(cfg);
  const s = state.load(cfg.package);
  if (cmd === 'status') {
    for (const c of Object.values(s.candidates).sort((x, y) => y.code - x.code)) {
      const last = c.history.at(-1);
      console.log(`${c.code}\t${c.stage}\t${last.at}\t${c.history[0].sha ?? ''}\t${(last.problems ?? []).slice(0, 2).join('; ')}`);
    }
    return;
  }
  const code = Number(need(a, 'code'));
  const c = s.candidates[code];
  if (!c) throw new Error(`no candidate ${code}`);
  if (cmd === 'approve') {
    if (c.stage !== 'tested') throw new Error(`candidate ${code} is ${c.stage}; only a tested one can be approved`);
    state.setStage(s, code, 'approved', { by: process.env.USER });
  } else if (cmd === 'retest') {
    if (!['env-blocked', 'failed', 'testing'].includes(c.stage)) throw new Error(`candidate ${code} is ${c.stage}`);
    state.setStage(s, code, 'built', { retest: true });
  }
  state.save(cfg.package, s);
  console.log(`${code}: ${s.candidates[code].stage}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
