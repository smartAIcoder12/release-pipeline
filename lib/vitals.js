// Crash rate of one versionCode from the Play Developer Reporting API (the numbers in Android vitals).
// Needs the Reporting API turned on in the service account's Google Cloud project and the service
// account allowed to "View app information" in Play Console. Any error means "unknown", and the
// runner then holds the rollout instead of guessing.
'use strict';
const play = require('./play');

const SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting';

async function crashRate(cfg, code, { days = 2 } = {}) {
  const c = play.client(play.loadServiceAccount(cfg.serviceAccount), SCOPE);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * 86400_000);
  const ymd = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), timeZone: { id: 'America/Los_Angeles' } });
  const body = await c.call('POST', `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${cfg.package}/crashRateMetricSet:query`, {
    json: { timelineSpec: { aggregationPeriod: 'DAILY', startTime: ymd(start), endTime: ymd(end) }, dimensions: ['versionCode'], metrics: ['crashRate', 'distinctUsers'] },
  });
  return rateFor(body.rows ?? [], code);
}

/** User-weighted crash rate of one versionCode over the returned days; null when Play has no rows yet. */
function rateFor(rows, code) {
  let users = 0;
  let crashed = 0;
  for (const r of rows) {
    if (r.dimensions?.find((d) => d.dimension === 'versionCode')?.stringValue !== String(code)) continue;
    const m = Object.fromEntries((r.metrics ?? []).map((x) => [x.metric, Number(x.decimalValue?.value)]));
    if (!Number.isFinite(m.crashRate) || !Number.isFinite(m.distinctUsers)) continue;
    users += m.distinctUsers;
    crashed += m.crashRate * m.distinctUsers;
  }
  return { rate: users ? crashed / users : null, users };
}

module.exports = { crashRate, rateFor };
