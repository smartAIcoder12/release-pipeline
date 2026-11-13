// Messages to the developer: a macOS notification, a line in the app's log, and (optional) a push to
// the phone through ntfy (`ntfyTopic` in pipeline.json; the topic name is the only secret).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const state = require('./state');

function send(cfg, title, body = '') {
  const line = `${new Date().toISOString()} ${cfg.package} ${title}${body ? ` — ${body}` : ''}\n`;
  fs.appendFileSync(path.join(state.appDir(cfg.package), 'log.txt'), line);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  spawnSync('osascript', ['-e', `display notification "${esc(body.slice(0, 200))}" with title "${esc(`${cfg.name ?? cfg.package}: ${title}`)}"`], { timeout: 10_000 });
  if (cfg.ntfyTopic) spawnSync('curl', ['-s', '-m', '15', '-H', `Title: ${cfg.name ?? cfg.package}: ${title}`, '-d', body || title, `https://ntfy.sh/${cfg.ntfyTopic}`], { timeout: 20_000 });
}

/** Sends a message only once per candidate and key (e.g. "rollout held"), not on every tick. */
function once(cfg, cand, key, title, body) {
  cand.notified ??= {};
  if (cand.notified[key]) return;
  cand.notified[key] = new Date().toISOString();
  send(cfg, title, body);
}

module.exports = { send, once };
