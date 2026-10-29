# StopCode live demo (8 steps, about 10 minutes)

This is an honest demo: everything the judge sees comes from real Claude Code hook events,
the real core, and a real (short) quiet-hours interval. Nothing is pre-recorded and no
number is invented. Each step lists what is **not** claimed so the narration stays accurate.

## Before you start

Requirements: Node 22+, Claude Code 2.1.312 or newer, Git. A browser for the dashboard.

```bash
cd "<repo>"                       # the StopCode checkout (paths with spaces are fine)
npm install                       # only dependency: @anthropic-ai/sdk (used by the wellness chat)
claude plugin validate .          # manifest + hooks + skills check
npm run demo -- --reset --seed    # isolated data dir <repo>/.stopcode-demo, baseline, dashboard on :4821
```

`npm run demo` prints the eight steps with absolute paths filled in, plus the exact Claude
Code launch line. It never touches `~/.stopcode`. Use three terminals:

- **Terminal A**: Claude Code inside `sample-project`, launched with the plugin (step 1).
- **Terminal B**: the demo script / dashboard (already running after the command above).
- **Terminal C**: optional CLI commands. Every CLI line below works from any directory
  because it passes `--data-dir "<repo>/.stopcode-demo" --project "<repo>/sample-project"`.
  (From inside `sample-project` with `STOPCODE_DATA_DIR` exported you can drop both flags.)

Placeholders: `<repo>` = absolute path of this checkout, `<sample>` = `<repo>/sample-project`,
`<demo-data>` = `<repo>/.stopcode-demo`. `SC` below stands for `node "<repo>/bin/stopcode.js" --data-dir "<demo-data>" --project "<sample>"`.

**Wellness chat API key (optional).** Set `ANTHROPIC_API_KEY` in the environment or in
`<repo>/.env` (see `.env.example`) *before* starting the dashboard. Without it the chat shows
its configuration-required state. That is fine for the demo: show the state and say the chat
integration is unverified on this machine. Do not fake a reply. A Claude Code subscription
does not provide API credentials.

**About the seed.** `--seed` creates, through the real core, exactly what a user could have
typed: one project (the sample), the mission "Fix login validation so empty passwords are
rejected" with two criteria, and a recovery block tomorrow 18:30–19:00 in the configured
timezone. It does **not** create activity, evidence, breaks or sessions. The sample lives
inside this repository's Git tree, so without `--seed` the first `/stopcode:start` registers
the project at the Git top level (the StopCode checkout itself) and names it after that
directory; everything still works, the project name is just different.

---

## Step 1 — Start a tracked mission and watch real activity

**Do:** in Terminal A, launch Claude Code in the sample project with the plugin and the demo
data directory.

Git Bash:

```bash
cd "<sample>" && STOPCODE_DATA_DIR="<demo-data>" claude --plugin-dir "<repo>"
```

Windows PowerShell:

```powershell
$env:STOPCODE_DATA_DIR = '<demo-data>'; Set-Location '<sample>'; claude --plugin-dir '<repo>'
```

Then, in Claude Code:

```
/stopcode:start Fix login validation so empty passwords are rejected
```

(If you seeded, this replaces the seeded mission and keeps it in history. To show the seeded
mission unchanged, run `/stopcode:status` instead.)

**Judge sees:** the skill runs one CLI command and reports the objective, 2–4 practical
criteria with ids, and "Tracking has begun". In the dashboard **Today** tab the project appears
with the mission, criteria, "No activity observed yet" until the first hook event, then the
first real events (session start, prompts, the tool calls the skill made). The integration
line shows the last hook event and its age, never a "connected" badge.

**Not claimed:** no focus time, no productivity score. "Elapsed" is wall-clock time between
recorded events. Time since last break is "unknown" because none was recorded.

---

## Step 2 — Fix the bug and capture real test evidence

**Do:** in Claude Code:

```
Run npm test, then fix the empty-password bug in src/auth.js and run npm test again.
```

`sample-project/README.md` describes the bug and the one-line fix. Before the fix `npm test`
fails 1 of 4; after it passes 4 of 4 (verified: exit code 1 then 0).

**Judge sees:** two `test_run` evidence entries appear under the mission, recorded by the
PostToolUse / PostToolUseFailure hooks, labelled with their source (`hook:PostToolUse`). The
failing run is recorded as `fail`. The passing run is recorded as `pass` with parsed counts
when the runner's summary format is recognised, otherwise as `unknown — command exited
successfully; result not parsed from output`. `unknown` is never displayed as success.

Then verify criterion 1 explicitly, either by asking Claude ("record the passing test run as
evidence for criterion 1" via `/stopcode:status`) or in Terminal C:

```bash
SC evidence add --kind test_run --outcome pass --summary "npm test in sample-project: 4 passed, 0 failed" --criterion 1
SC status
```

Output: `Evidence recorded: test_run/pass (evd_…) → criterion "auth tests pass …" is now verified`.
The status headline changes to `In progress (1 of 2 verified)`.

**Not claimed:** StopCode does not say the goal is complete. "Your original goal is complete"
appears only when every criterion has passing evidence (criterion 2 is still open). A file
edit is never evidence; only a recorded check is.

---

## Step 3 — Park an optional idea, then talk to the wellness chat

**Do:** in the dashboard Today tab, **Park this idea** → `Add a password strength meter`.
CLI alternative:

```bash
SC idea add "Add a password strength meter"
```

Output: `Parked: Add a password strength meter (idea_…). No new mission was started.`

Then open the **Chat** tab and send: `Help me stop for today.`

**Judge sees:** the idea appears as *parked* (not as a task, not as a new mission; the original
objective is unchanged). With an API key: a short reply from the wellness assistant and
optional suggestion buttons (park an idea, add a recovery block, clock out); each button only
says "Done" after the action actually persisted. Without an API key: the configuration-required
state instead of a reply (the API reports `configured: false` and answers a message with
`missing_credentials`; the typed message is still kept in the conversation).

**Not claimed:** the chat is a separate assistant with its own conversation history and system
prompt; it never reads the Claude Code conversation. It receives a StopCode summary only if
"share summary" is enabled in Settings. Its advice is advisory. If there is no key, say "chat
integration is unverified here" and move on.

---

## Step 4 — Plan a recovery block and export it

**Do:** **Planner** tab → add a *recovery* block (for example tomorrow 18:30–19:00) → **Export
.ics**. CLI alternative (UTC ISO times):

```bash
SC planner add --title "Walk" --type recovery --start 2026-10-30T18:30:00Z --end 2026-10-30T19:00:00Z
SC planner ics --out demo-planner.ics
```

**Judge sees:** the block on the planner; overlapping blocks are reported and need an explicit
"keep both" (the CLI needs `--allow-overlap`). The exported `.ics` is RFC 5545 with UTC
instants, a stable `UID` per event and a `SEQUENCE` that increases on edits, so re-importing
updates instead of duplicating in clients that honour UID. The seeded block from `--seed` is
already there if you used it.

**Not claimed:** no Google/Outlook sync. Export is one-way; later edits in StopCode are not
pushed to a calendar (the event description says so).

---

## Step 5 — Clock out for a short, clearly labelled real interval

**Do:** Today tab → **Clock out** → quiet hours **2 minutes**, **Block new coding actions**
checked → confirm → open the saved handoff. CLI alternative:

```bash
SC finish --quiet 2m --protect --note "demo clock-out"
SC handoff show
```

**Judge sees:** a step-by-step receipt, each part reported separately:

```
Handoff: saved → <demo-data>/handoffs/<projectId>/<timestamp>-<missionId>.md
Session: tracked session ended (…); the Claude Code process is not closed by StopCode
Mission: parked — In progress (1 of 2 verified)
Quiet hours: active until <date> <HH:MM> — blocking new tool actions in sample-project
Next action when you return: Start: an empty password is rejected with code empty_password
Your work is parked.
```

The handoff Markdown has: the original mission, accepted additions (none), criteria with their
evidence, **checks not run**, files touched during tracked sessions, Git branch/uncommitted
count, deferred ideas (the parked strength meter), the next action, a resume-context block,
and the elapsed times labelled as wall clock.

**Not claimed:** StopCode did not commit, stash or reset anything; the handoff is not a backup of
unsaved editor buffers. Claude Code was not closed. Nobody "rested"; a 2-minute interval is
chosen so the judge can watch it expire.

---

## Step 6 — Show the boundary holding

**Do:** within the 2 minutes, in Claude Code (Terminal A):

```
Add a password strength meter to src/auth.js
```

Then in Terminal C:

```bash
git -C "<repo>" status --short -- sample-project
```

**Judge sees:** Claude Code shows the prompt was blocked by the UserPromptSubmit hook with the
reason: `StopCode quiet hours are active for sample-project until <time>. Your work is parked;
the latest handoff has the next step. To lift the boundary now, run /stopcode:resume …`. If a
turn was already running, the PreToolUse hook denies each new tool call with a similar reason
(`permissionDecision: deny`). `git status` shows the same single change as before the clock-out
(the step-2 fix); no new edit happened. The dashboard timeline shows a `prompt_blocked` (or
`tool_blocked`) event.

**Not claimed:** quiet hours cover this project's Claude Code sessions only. They do not lock the
editor, the terminal, other projects or other tools, and they do not cancel a command that was
already running. The StopCode CLI's own `status/resume/quiet/handoff/doctor` commands stay
allowed so the user is never locked out of their own data.

---

## Step 7 — The wellness chat still works while coding is blocked

**Do:** Chat tab → `What can I do with the next 10 minutes?`

**Judge sees:** with an API key, a reply arrives while coding is still blocked (the chat goes
through the dashboard backend, not through Claude Code, so the boundary does not apply to it).
Without a key: the same honest configuration-required state as in step 3.

**Not claimed:** the chat does not know what you did in Claude Code unless "share summary" is
on, and even then it only gets the StopCode summary (mission, criteria status, elapsed time,
quiet state), never prompts or file contents.

---

## Step 8 — Resume on purpose

**Do:** in Claude Code:

```
/stopcode:resume
```

CLI alternative:

```bash
SC resume              # exit code 3 while the boundary is active
SC resume --override   # explicit override
```

**Judge sees (boundary still active):** the skill first runs `resume` without an override; the
CLI answers `Quiet hours are active for sample-project until <time>. Resume with an explicit
override to lift them.` (exit code 3). The skill asks one yes/no question: "Lift the quiet-hours
boundary now?" Only after an explicit yes does it run `resume --override`, which prints the
mission, its status headline, the next action and the resume-context block, then
`Nothing was started automatically.` Claude stops there and waits.

**Judge sees (interval already expired):** `resume` is not blocked; it restores the handoff
directly. Until then, status shows `Quiet hours: interval ended at <time>; resume when you choose
(nothing starts automatically)`: nothing starts by itself when the interval ends.

**Not claimed:** resuming restores context; it does not launch work, run tests or open files.
Completed and archived missions stay in history.

---

## Reset the demo

```bash
npm run demo -- --reset            # wipe <repo>/.stopcode-demo and start the dashboard empty
npm run demo -- --reset --seed     # wipe and re-create the baseline
git -C "<repo>" checkout -- sample-project/src/auth.js   # restore the deliberate bug
```

`--reset` refuses to delete anything other than `<repo>/.stopcode-demo`, and the script refuses
to run at all if that directory would overlap `~/.stopcode`.

## If something looks wrong

- **No hook events in the dashboard:** Terminal A must have `STOPCODE_DATA_DIR` set to
  `<demo-data>` and be launched with `--plugin-dir "<repo>"`. Check `SC doctor`: the hooks line
  shows the last real event or "no hook event observed yet". A `DEGRADED` note means a hook
  failed open and recorded the error in `<demo-data>/health.json`.
- **Port 4821 busy:** `npm run demo -- --port 4822`.
- **The chat says configuration required:** expected without `ANTHROPIC_API_KEY`. Configured
  and tested are shown separately; "Test connection" in Settings performs a real call.
- **Claude Code printed nothing at startup:** the SessionStart context is injected for Claude,
  not displayed; `/stopcode:status` shows the same information.
