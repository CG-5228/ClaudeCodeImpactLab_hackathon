---
name: status
description: Show the StopCode mission, verification evidence, deferred work, elapsed time and boundary state for this project, concisely. Use when the user runs /stopcode:status or asks where the mission stands.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" *) Bash(stopcode *)
---

# /stopcode:status

Optional focus from the user: $ARGUMENTS

## Steps

1. Run exactly this command on its own (no `cd`, `&&`, `;`, pipes or redirection; during quiet hours only the bare StopCode command passes the hook):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" status
   ```

2. Relay the output faithfully and concisely (no more than ~15 lines): mission and its status headline, each criterion with its state and evidence, the next step, elapsed time **labelled as elapsed wall-clock time**, breaks (say "unknown" when none is recorded), quiet-hours and monitoring state, parked ideas and accepted additions, and the integration line.
3. If the output says there is no StopCode project here, say so and point to `/stopcode:start <goal>`.

## Recording progress (only when the user asks, or when you just ran a check in this session)

- A check you actually ran this session can be recorded as evidence:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" evidence add --kind test_run|build|command|manual_check --outcome pass|fail|unknown --summary "<command and parsed result>" --criterion <id or number>`
  Only use `--outcome pass` when the output you saw shows the check passed. Unknown results are `unknown`, never `pass`.
- When the user states a criterion is done without a check: `criterion confirm <id>` records a **user confirmation**, which StopCode labels separately from verification.
- Classify new requests conservatively as in scope, necessary dependency, optional improvement, scope expansion, unrelated, or uncertain. Running the relevant tests for the goal is in scope; fixing a dependency the goal needs is usually in scope; "also reject empty passwords" during a login-validation fix is not automatically an expansion; adding a mobile app is. Record decisions with `scope accept "<text>"` (accepted addition) or `idea add "<text>"` (deferred); do not block work over scope and do not re-raise additions the user already accepted.

## Rules

- Never present elapsed time as focused time, and never claim the user rested because no activity was observed.
- "Your original goal is complete" is only true when the status output says so; otherwise report the actual state (for example "Verification pending").
