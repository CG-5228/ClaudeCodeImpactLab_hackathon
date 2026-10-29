---
name: start
description: Start a StopCode mission for this project - save the original objective, set a few practical completion criteria, and begin tracking. Use when the user runs /stopcode:start or asks to begin a tracked mission.
argument-hint: <one-sentence goal> [--budget <minutes>]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" *) Bash(stopcode *)
---

# /stopcode:start

Mission text from the user: $ARGUMENTS

StopCode keeps the original goal immutable and visible so the day does not quietly expand. This skill records it; it does not start the work.

## Steps

1. If the mission text is empty, ask one short question: "What is the one goal for this session?" Then continue with the answer. Do not run a long onboarding.
2. Derive 2 to 4 **practical completion criteria**: observable checks a person could verify (for example "auth tests pass", "login rejects an empty password with 400", "README documents the flag"). Keep them small and faithful to the goal; do not add requirements the user did not imply. If the text contains `--budget <minutes>`, treat it as an optional advisory time budget.
3. Run exactly one command (the project is detected from the current working directory):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" start "<objective>" --criteria "<criterion 1>" --criteria "<criterion 2>" [--budget <minutes>]
   ```

   Pass `--project "<path>"` only if the user explicitly named a different project directory.
4. Report the command's output in at most 6 lines: the saved objective, the criteria with their ids, and that tracking has begun. Mention `/stopcode:status` and `/stopcode:finish`.
5. If a previous mission existed, the command preserves it in history and says so; repeat that to the user.

## Rules

- Do not begin implementing the mission in this turn unless the user explicitly asked for that as well.
- Later requests that go beyond this objective are recorded, not silently absorbed: `stopcode scope accept "<text>"` for an accepted addition, `stopcode idea add "<text>"` to park an idea for later.
- Evidence for criteria is recorded with `stopcode evidence add --kind test_run --outcome pass|fail|unknown --summary "<what ran>" --criterion <id>`; a file edit alone is not evidence that a criterion is met.
