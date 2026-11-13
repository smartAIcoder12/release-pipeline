// The two jobs that need judgement, done by Claude Code in headless mode (`claude -p`) inside the app
// repo, each with its skill from this repo. Neither one can release anything: the fixer pushes a
// commit, which goes through CI and the phone tests again; the explorer only writes a report.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SKILLS = path.join(__dirname, '..', 'skills');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const FIX_TAG = '[release-fix]';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status)'];

function skill(name) {
  return fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
}

/** Starts a fix in the background. It ends with one commit pushed to main, or a report of why not. */
function startFix(cfg, code, result, sha) {
  const dir = result.dir;
  const prompt = [
    `Phone tests failed for ${cfg.package} versionCode ${code} (commit ${sha ?? 'unknown'}).`,
    `Failures:\n${result.problems.map((p) => `- ${p}`).join('\n')}`,
    `Evidence (screenshots, Maestro output, logcat): ${dir}`,
    `Follow the release-fix rules below. Commit message must start with "${FIX_TAG}".`,
  ].join('\n\n');
  const log = fs.openSync(path.join(dir, 'fix.log'), 'a');
  const tools = [...READ_TOOLS, 'Edit', 'Write', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx tsc:*)', 'Bash(npx expo lint:*)', 'Bash(npx jest:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push origin main)', 'Bash(git pull --rebase origin main)'];
  const child = spawn(CLAUDE, ['-p', prompt, '--append-system-prompt', skill('release-fix'), '--permission-mode', 'acceptEdits', '--allowedTools', tools.join(' '), '--add-dir', dir], { cwd: cfg.appDir, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child.pid;
}

/** Hands-on test of what changed since `fromSha`, on the phone. Synchronous; returns the report text. */
function explore(cfg, code, fromSha, toSha, dir) {
  const prompt = [
    `Test what changed in ${cfg.package} between ${fromSha} and ${toSha}. versionCode ${code} is installed on the phone ${cfg.device}.`,
    `Save screenshots to ${dir}. Write your report to ${path.join(dir, 'explore.md')}.`,
  ].join('\n\n');
  const adb = `Bash(${require('./device').ADB}:*)`;
  const r = spawnSync(CLAUDE, ['-p', prompt, '--append-system-prompt', skill('release-explore'), '--permission-mode', 'acceptEdits', '--allowedTools', [...READ_TOOLS, adb, 'Write'].join(' '), '--add-dir', dir], { cwd: cfg.appDir, encoding: 'utf8', timeout: 40 * 60_000 });
  fs.writeFileSync(path.join(dir, 'explore.log'), (r.stdout ?? '') + (r.stderr ?? ''));
  const report = path.join(dir, 'explore.md');
  return fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : null;
}

/** Reads the verdict line the explore skill asks for: "VERDICT: ok" or "VERDICT: problems". */
const verdict = (report) => (/^VERDICT:\s*(ok|problems)/im.exec(report ?? '')?.[1] ?? 'unknown');

module.exports = { startFix, explore, verdict, FIX_TAG };
