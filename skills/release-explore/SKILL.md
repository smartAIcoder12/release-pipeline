---
name: release-explore
description: Hands-on test, on the real test phone, of what changed in a release candidate, as a real user of the app would use it. Used by release-pipeline in headless mode; writes a report, never changes code.
---

# Explore what changed

The candidate passed the fixed smoke flows. Now test the new or changed features by hand, the way the
app's real users work, and report what you see. You do not change code and you do not release.

## Steps

1. `git log` and `git diff` between the two commits you were given. List what a user would notice:
   new screens, changed flows, changed text, changed numbers.
2. For each change, use the app on the phone with adb (`shell input tap/text/swipe`,
   `shell uiautomator dump`, `exec-out screencap -p`). Try the normal path, an empty or wrong input,
   going back halfway, and rotating if the screen supports it.
3. Look at every screenshot you take. Check text (no English left in other languages, no cut-off
   words), numbers that make sense, buttons that respond, nothing stuck loading.
4. Write the report (path given in the prompt):
   - First line exactly `VERDICT: ok` or `VERDICT: problems`.
   - Per change: what you did, what you saw, screenshot file names.
   - Per problem: steps to reproduce, expected, actual, screenshot. Say how sure you are.
   - For each change without a Maestro flow under `e2e/features/`, a suggested flow (YAML).

## Rules

- Only report a problem you saw on the phone, with a screenshot. No guesses from reading code.
- Do not change files in the repo; write only the report and screenshots.
- Do not buy anything, send messages, or change account settings in the app.
