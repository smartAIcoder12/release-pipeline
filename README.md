# release-pipeline

Every push to `main` of an app becomes a release candidate. GitHub builds it and puts it on Google
Play's internal test track. A Mac with a test phone downloads the Play-signed APK, installs it over
the current app, runs the app's Maestro flows, and has Claude test what changed by hand. A tested
candidate goes to production after approval. The same versionCode goes, with no rebuild, in
stages: 10%, 50%, then 100%, each after a crash-rate check. A failure goes to Claude for a fix. The
fix is one commit, which starts the cycle again, at most 3 times.

```
push main ─▶ GitHub: checks ─▶ build AAB ─▶ verify signature ─▶ Play internal (versionCode = max+1)
                                                                    │
Mac (launchd, every 5 min) ◀────────────────────────────────────────┘
  preflight phone ─▶ download Play-signed APK ─▶ install -r ─▶ Maestro flows (retry once) ─▶ crashes?
     │ env problem: notify, retry later           │ failed: notify, Claude fixes ─▶ push main ─▶ …
     ▼ passed: Claude explores the diff (report only)
  notify "ready" ─▶ rp approve ─▶ production 10% ─▶ 24 h, crash rate ok ─▶ 50% ─▶ 100%
                                                    crash rate too high ─▶ halt, notify
```

Decisions are made in code (`lib/runner.js`). Claude is used only for two jobs that need judgement:
the hands-on test (`skills/release-explore`) and the fix (`skills/release-fix`). Neither can release
anything. The hands-on test only writes a report. A fix is a normal commit that goes through CI and
the phone tests again.

## Reliability

- **Resumable.** The state of each candidate is in `~/.release-pipeline/<package>/state.json`, and
  each step reads it first. A test that died with the Mac starts again after 45 minutes.
- **The tested build is the released build.** Production gets the same versionCode that passed on
  the phone. Nothing is rebuilt.
- **Same signature as users get.** The phone installs the universal APK that Play signed, and
  upgrades over the installed app, so the upgrade path is tested too.
- **Environment problems are not app bugs.** These are: a missing phone, a low battery, no internet,
  or a failed download. They block the test and send a notification. They never start a fix.
- **Guard rails.** A fix commit (`[release-fix]`) may not touch `e2e/smoke/` or `.github/`, and CI
  refuses it if it does. The pipeline stops fixing after 3 failed candidates in a row, or when the
  same failure comes back.
- **Off switch.** `touch ~/.release-pipeline/PAUSE` pauses every app, and
  `~/.release-pipeline/<package>/PAUSE` pauses one.
- **One at a time.** There is one lock per app, and the whole tick runs inside the Mac's e2e lock,
  so other phone tests on this Mac wait.

## Add an app

1. **The app's GitHub workflow.** Use `.github/workflows/release.yml` in ListSoEasy as the example.
   It calls `smartAIcoder12/release-pipeline/.github/workflows/android.yml@main` and needs these
   secrets:
   - `PLAY_SERVICE_ACCOUNT`
   - `APP_ENV`
   - `UPLOAD_JKS_BASE64`
   - `UPLOAD_STORE_PASSWORD`
   - `UPLOAD_KEY_ALIAS`
   - `UPLOAD_KEY_PASSWORD`
2. **The versionCode.** `app.config.ts` takes it from `ANDROID_VERSION_CODE` when that is set.
3. **Signing.** The upload-key signing reads Gradle properties with the app's prefix, for example
   `LISTSOEASY_UPLOAD_STORE_FILE`.
4. **`pipeline.json`** at the repo root:
   - `package`
   - `device` (the adb serial)
   - `serviceAccount` (a local path)
   - optionally `fix`, `explore` and `release`

   Then add its path to `~/.release-pipeline/apps.txt`.
5. **Maestro flows.** Put them in `e2e/smoke/`, and in `e2e/features/` for each new feature. Find
   elements by `testID`.
6. **Once per Mac:** `bin/install-launchd.sh`.

## Commands

```bash
rp status  --config ~/work/app/pipeline.json      # candidates and stages
rp approve --config ~/work/app/pipeline.json --code 12
rp retest  --config ~/work/app/pipeline.json --code 12
rp tracks  --package com.example.app --key key.json
```

`npm test` runs this repo's own tests.

## Limits

- **A new app's first production release.** Play accepts only draft releases until an app has had
  one production release. That first release has to be sent from Play Console, after every App
  content declaration is done.
- **Review time.** Google reviews every production release, which takes hours to days. So the
  pipeline keeps one candidate at a time in review.
- **Crash rate.** The check needs the Play Developer Reporting API turned on for the service
  account. Without it the rollout holds and sends a notification. It does not guess.
