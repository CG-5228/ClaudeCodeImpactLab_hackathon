---
name: pause
description: Pause StopCode monitoring and advice for this project without discarding state. Use when the user runs /stopcode:pause. Does not close Claude Code and does not lift an active quiet-hours boundary.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" *) Bash(stopcode *)
---

# /stopcode:pause

## Steps

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" pause
   ```

2. Tell the user, in 3 lines or fewer, exactly what the command reported:
   - activity capture and advisory messages are paused for this project; the mission, criteria, evidence and ideas are kept;
   - this does **not** close Claude Code, stop running commands, or disable an already active quiet-hours boundary (if the output says quiet hours are active, repeat the end time);
   - monitoring resumes with `node "${CLAUDE_PLUGIN_ROOT}/bin/stopcode.js" unpause`.

If the user says "unpause" or "resume monitoring", run the `unpause` command instead and confirm.
