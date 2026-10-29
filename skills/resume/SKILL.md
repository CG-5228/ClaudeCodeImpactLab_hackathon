---
name: resume
description: Restore the latest StopCode handoff and mission for this project. If quiet hours are active, asks for an explicit override before lifting them. Use when the user runs /stopcode:resume or wants to pick the parked work back up.
argument-hint: [--override]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" *) Bash(stopcode *)
---

# /stopcode:resume

Arguments from the user: $ARGUMENTS

During quiet hours the StopCode hook lets only a **bare** StopCode command through: run each command below exactly as written, on its own line, with no `cd`, no `&&`, no `;`, no pipes and no redirection. Read the command's text output; do not append anything to inspect exit codes.

## Steps

1. Run without an override first (unless the user already passed `--override`, in which case go to step 2's second command):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" resume
   ```

2. If the output says quiet hours are active ("Quiet hours are active ... Resume with an explicit override"): tell the user when the interval ends and ask one explicit yes/no question: "Lift the quiet-hours boundary now?" Only if the user clearly says yes (or already passed `--override`), run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" resume --override
   ```

   If they say no, stop here; their work stays parked and the wellness chat in the dashboard remains available.
3. On success, show at most 10 lines: the mission, its status headline, the **next action**, and the resume-context block from the handoff. Mention the handoff path for the full receipt.
4. Then stop and wait. Do **not** start implementing the next action, run tests, or open files until the user asks. Resuming restores context; it does not launch work.

## Rules

- Completed and archived missions stay in history; resuming never deletes them.
- If there is no handoff yet, say so and show the mission status instead.
