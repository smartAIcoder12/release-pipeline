// One JSON file per app: the stage of every candidate versionCode, with the evidence for each step.
// Every runner step reads the stage first, so a run that died halfway (Mac restart, killed session)
// carries on from where it stopped instead of starting over.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.RP_HOME || path.join(os.homedir(), '.release-pipeline');

// built → testing → tested | failed | env-blocked → approved → rollout → released | halted
const STAGES = ['built', 'testing', 'tested', 'failed', 'env-blocked', 'approved', 'rollout', 'released', 'halted', 'superseded'];

function appDir(pkg) {
  const d = path.join(HOME, pkg);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function load(pkg) {
  const f = path.join(appDir(pkg), 'state.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { candidates: {} };
}

/** Writes through a temp file and rename, so a crash never leaves half a JSON file. */
function save(pkg, state) {
  const f = path.join(appDir(pkg), 'state.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}

function setStage(state, code, stage, note = {}) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  const c = (state.candidates[code] ??= { code: Number(code), history: [] });
  c.stage = stage;
  c.history.push({ at: new Date().toISOString(), stage, ...note });
  return c;
}

function runDir(pkg, code) {
  const d = path.join(appDir(pkg), 'runs', String(code));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A lock directory with the owner's pid; a lock whose process is gone is taken over. */
function lock(name) {
  const d = path.join(HOME, `${name}.lock`);
  fs.mkdirSync(HOME, { recursive: true });
  try {
    fs.mkdirSync(d);
  } catch {
    const pid = Number(fs.readFileSync(path.join(d, 'pid'), 'utf8').trim() || 0);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) return null;
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d);
  }
  fs.writeFileSync(path.join(d, 'pid'), String(process.pid));
  return () => fs.rmSync(d, { recursive: true, force: true });
}

/** `touch ~/.release-pipeline/PAUSE` stops every app; `<pkg>/PAUSE` stops one. */
const paused = (pkg) => fs.existsSync(path.join(HOME, 'PAUSE')) || fs.existsSync(path.join(HOME, pkg, 'PAUSE'));

module.exports = { HOME, STAGES, load, save, setStage, runDir, lock, paused, appDir };
