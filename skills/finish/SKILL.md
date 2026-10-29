---
name: finish
description: Save an accurate StopCode handoff and logically end the tracked session, even if the work is incomplete, optionally starting quiet hours the user chose. Use when the user runs /stopcode:finish, says they want to stop or clock out for the day.
argument-hint: [30m|2h|until HH:MM|tomorrow] [--protect] [--complete] [note]
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" *) Bash(stopcode *)
---

# /stopcode:finish

Arguments from the user: $ARGUMENTS

Stopping must never require the mission to be complete. Your job is to park the work honestly, not to finish it.

## Steps

1. Do not start or continue implementation work. If a command you launched earlier is still running, leave it alone and mention it.
2. Interpret the arguments:
   - a duration (`30m`, `2h`) or `until HH:MM` / `tomorrow` = the quiet interval the user wants;
   - `--protect` = block new coding actions in this project during the interval (StopCode's PreToolUse hook denies new tool calls; it does not close Claude Code, cancel running commands, or affect other projects);
   - `--complete` = the user states the original goal is done (recorded as a user confirmation, separate from verification);
   - any other words = a one-line note for the handoff.
3. If the arguments do not say whether to protect the time, ask **one** question with AskUserQuestion: "How do you want to stop?" with options "Just park my work (no blocking)", "Park and block new coding here for 30 minutes", "Park and block new coding here until my next working block". Keep it short; accept the answer and move on.
4. Run exactly one command, built from the choices, on its own (no `cd`, `&&`, `;`, pipes or redirection):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" finish [--quiet <duration>] [--until <HH:MM|tomorrow>] [--protect] [--complete] [--note "<one line>"]
   ```

5. Report **exactly** what the command reported, line by line: handoff saved (with its path) or failed; tracked session ended; mission parked or completed; quiet hours active until a time (blocking or advisory) or not requested or failed. If one part failed, say so plainly; do not summarise two results as one success.
6. Close with "Your work is parked." only if the handoff saved. Never claim Claude Code exited or that the user has rested.

## After finishing

Do not propose new tasks or a backlog. If the user keeps chatting, be brief. Their next action is written in the handoff; `/stopcode:resume` restores it later.
