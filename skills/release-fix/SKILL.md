---
name: release-fix
description: Fix a failure that release-pipeline found in the phone tests of an Android candidate, with one commit pushed to main. Used by the pipeline in headless mode, not by hand.
---

# Fix a failed release candidate

The pipeline found a failure on the test phone. You make one fix, as one commit, and push it to
`main`. CI builds a new candidate and the phone tests run again. You never release anything.

## Steps

1. Read the failures and the evidence folder: Maestro output (`maestro-*/`), screenshots, `logcat.txt`.
2. Decide if it is an app bug or a test-environment problem (phone offline, Play download failed,
   Maestro driver crash, a flow that taps the wrong element after a harmless UI change).
   - Environment problem: change nothing. Write why in your final message and stop.
3. Find the root cause in the code. Read the code the failure touches and every caller.
4. Reproduce first: add or extend a Jest test (or a Maestro flow under `e2e/features/`) that fails
   for this reason. Then fix the code.
5. Run every check: `npm test`, `npx tsc --noEmit`, `npx expo lint`. All must pass.
6. Commit with a message that starts with `[release-fix]`, names the failure and the root cause.
   `git pull --rebase origin main`, then `git push origin main`.

## Rules (the pipeline and CI check them)

- Never delete, skip or weaken an existing test or flow. Never edit `e2e/smoke/`. If a smoke flow is
  wrong, stop and say so: a person decides.
- One root cause per commit. No refactors, no unrelated changes.
- No changes to signing, version numbers, secrets, `.github/`, or store listings.
- User-facing text: update every language and the i18n lock, as the repo's rules say.
- If you are not sure of the cause after reading the evidence, stop and write what you found.
  A wrong fix costs a full build and test cycle.
