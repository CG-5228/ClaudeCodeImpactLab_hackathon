# Verification record

What was exercised while building StopCode, with the observed results. Dates are 2026-10-29, Windows 11, Node v24.19.0, Claude Code 2.1.312.

## Real Claude Code integration (not fixtures)

Method: non-interactive nested sessions, `claude -p "..." --plugin-dir "<repo>"`, started from a
throwaway project directory with a space in its path, with `STOPCODE_DATA_DIR` pointing at a
scratch directory. The script `scripts/live-check.sh` reproduces this; its last run on the build
machine reported `Summary: 11 passed, 0 failed` (model `claude-sonnet-5-5`, 6 real sessions).

| Scenario | Observed |
| --- | --- |
| Plugin loads from a path with spaces | `claude plugin validate .` passes; hooks fired with `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` set |
| Hook events fire (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) | all recorded in the scratch data dir; `doctor` shows "last real event SessionEnd just now" |
| `/stopcode:status` skill | Claude ran the CLI through the skill and relayed mission, criteria, elapsed time labelled as wall-clock, breaks "unknown, none recorded", quiet-hours state, integration line |
| Advisory (UserPromptSubmit `additionalContext`) | Claude mentioned, once, that it was outside working hours and that `/stopcode:finish` saves a handoff; it did not stop work on its own |
| Protected quiet hours + new Write in the same turn | PreToolUse returned `permissionDecision: deny`; Claude replied `DENIED: StopCode quiet hours are active ... until 19:01`; `blocked.txt` was not created; no retry |
| New prompt during protected quiet hours | `UserPromptSubmit operation blocked by hook:` followed by the StopCode reason; nothing ran |
| `/stopcode:resume` during protected quiet hours | the skill's bare CLI command passed the allowlist; Claude reported the end time and asked "Do you want to lift the quiet-hours boundary now?"; quiet hours stayed active |
| `/stopcode:resume --override` | quiet hours lifted explicitly; Claude showed mission, status, next action and stated it had not started any work |
| `stopcode finish --quiet 10m --protect` (CLI) | handoff written, mission parked, quiet active until the stated local time, each step reported on its own line |

## Hook contract fixtures (scripted stdin, real hook script)

PreToolUse deny JSON during protected quiet; no output when not enforced; allowlist accepts
`node "<path with space>/bin/stopcode.js" status`, `stopcode resume --override`, `... 2>&1`,
`...; echo "exit=$?"` and denies `&&`, `;`, `|`, `>`, `$(...)`, `{}`, newlines, `cd ... &&`, env
prefixes; UserPromptSubmit `decision: block` during protected quiet except `/stopcode:*`
commands; PostToolUse `npm test` with "Tests: 1 failed, 3 passed" recorded as evidence
`fail`; Stop returns nothing; malformed stdin exits 0 with no output; unrelated cwd returns
nothing; a PreToolUse round trip takes about 0.3 s including Node start-up.

## Core behaviour (scripted)

Mission start, duplicate SessionStart, duplicate tool events (same `tool_use_id`) recorded once,
test-output parsing (node --test, jest, pytest, go, cargo), evidence attach -> criterion verified,
scope hint on "also ... while you're at it", park idea, clock-out per-step results, resume
blocked without override / allowed with override, handoff Markdown sections, planner overlap
conflict and "keep both", ICS output passing the structural linter (CRLF, 75-octet folding,
escaping, UTC times, stable UIDs), DST and timezone math (London DST start, Los Angeles vs
London "until 09:00", Friday evening -> Monday 09:00 next working start).

## macOS follow-up (2026-10-29, Claude Code 2.1.308, Node v24.21.0)

Behaviour change after the live runs above: the advisory note after 3 hours or outside working
hours is now opt-in (`advice.timeNudges`, Settings → Boundary preferences); scope hints are
unchanged. The "Advisory" row in the first table was recorded before this change; with time
reminders enabled the behaviour is the same.
`tests/hooks.quiet.test.js` covers both defaults. `scripts/live-check.sh` was re-run after this
change: `Summary: 11 passed, 0 failed.`

CI: `.github/workflows/test.yml` (Ubuntu and macOS, Node 22 and 24) runs `npm test`,
`npm run try` and the sample-project check; first run succeeded on all four jobs.

`npm test`: 27 passed, 0 failed (includes `npm run try`, which reports `Summary: 13 passed, 0 failed.`). `claude plugin validate .`: passed. `scripts/live-check.sh`
with real Claude Code 2.1.308 (model `claude-sonnet-5-5`): `Summary: 11 passed, 0 failed`:
status skill, hook events in health.json, PreToolUse deny of a Write (file not created), blocked
prompt, resume keeping the boundary without override, `--override` lifting it.
