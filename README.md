# StopCode

**Know when to exit the loop.** AI helps you code faster; StopCode helps you know when to stop.

A Claude Code plugin plus a local dashboard that keeps your original goal visible, shows your
workload from real hook activity, parks unfinished work in an honest handoff, and protects the
recovery time you choose.

## The problem: compression burnout

AI compresses work. A task that took an afternoon now takes an hour, so the afternoon fills with
two more tasks. The original goal quietly expands ("while you're at it…"), the day gets longer,
and the gains in speed turn into gains in volume rather than time back.

Stopping also got harder. Half-finished AI-assisted work is hard to put down: the context lives in
a conversation, the next step is in your head, and closing the laptop feels like losing your
place. So you keep going. StopCode is built for the developer in that loop.

## What StopCode does

1. **Workload and recovery dashboard** — the original mission and its completion criteria,
   verification evidence, elapsed wall-clock time, after-hours activity and recorded breaks, all
   derived from real Claude Code hook events. One primary action: **Clock out**.
2. **Wellness chat** — a separate assistant (Claude API through the local backend, its own
   conversation history and system prompt, never your Claude Code conversation) that helps you
   stop, park ideas and plan recovery. Its suggestions are buttons; nothing happens until you click.
3. **Calendar planner** — working hours, breaks, recovery blocks and personal time, with
   overlap detection and `.ics` export.
4. **Claude Code plugin** — hooks and skills (`/stopcode:start`, `status`, `pause`, `finish`,
   `resume`) that record the goal, capture bounded activity, save handoffs, and enforce opt-in quiet
   hours deterministically.

Core promise: **"I can stop without losing my place."**

## Honest by design

- **What it measures:** elapsed wall-clock time between recorded events, and the hook events
  themselves (tool calls, edits, commands, prompts, test/build runs). That is all.
- **What it never claims:** focus time, rest, hours saved, burnout scores, streaks. "Time since last
  break" is *unknown* until you record a break. Elapsed time is always labelled elapsed.
- **Completion is evidence-based.** "Your original goal is complete" appears only when every
  criterion has passing evidence attached. A user's "it's done" is recorded as a *user
  confirmation*, labelled separately from verification. A file edit is never evidence.
- **Configuration is not connection.** An API key being set and a successful test call are shown
  separately; the integration line shows the last real hook event or "No activity observed yet".
- **Advice is advisory.** Hook-injected nudges are rate-limited, dismissible and never block.
  Enforcement (quiet hours) is a separate, explicit opt-in per project, and the StopCode CLI stays
  usable during it.
- **API failure never blocks** clocking out, saving a handoff or scheduling. No telemetry. The
  dashboard makes no external requests; only the chat backend calls the Claude API.

## Quick start

Requirements: Node >= 22, Claude Code 2.1.312 or newer (the version this was built and tested
against), Git (optional, used for project roots and handoff Git state).

```bash
git clone <this repository> stopcode && cd stopcode
npm install                       # single dependency: @anthropic-ai/sdk (wellness chat only)
claude plugin validate .          # checks .claude-plugin/plugin.json, hooks/ and skills/
```

Load the plugin in **any** project (quotes make paths with spaces work; hooks are declared with
an args array, so `${CLAUDE_PLUGIN_ROOT}` with spaces is fine too):

```bash
cd ~/code/my-project
claude --plugin-dir "/absolute/path/to/stopcode"
```

Start the dashboard (binds to 127.0.0.1 only):

```bash
npm start                         # http://127.0.0.1:4821   (--port / STOPCODE_PORT to change)
```

### Wellness chat setup (separate, optional)

The chat calls the Claude API from the dashboard backend. Provide credentials to the **server**
only; they never reach the browser, the logs or the state files.

```bash
cp .env.example .env              # then set ANTHROPIC_API_KEY=sk-ant-...   (.env is git-ignored)
# or: export ANTHROPIC_API_KEY=sk-ant-...
# model: STOPCODE_CHAT_MODEL (default claude-opus-5-5)
```

A Claude Code subscription does **not** provide API credentials; you need an API key from the
Anthropic Console. Without one the chat shows a configuration-required state; everything else
works. Settings → *Test connection* performs a real call and records the result; until then the
dashboard says "configured, not tested".

## Claude Code skills

| Skill | What it does | Does not |
| --- | --- | --- |
| `/stopcode:start <goal>` | Records the original objective and 2–4 practical completion criteria; begins tracking. | Start the work. |
| `/stopcode:status` | Mission, criteria with evidence, next step, elapsed (wall clock), breaks, quiet/monitoring state, integration line. Can record evidence for checks Claude actually ran. | Call anything complete without evidence. |
| `/stopcode:pause` | Pauses activity capture and advice for this project. | Close Claude Code, block coding, or lift quiet hours. |
| `/stopcode:finish [30m\|2h\|until HH:MM\|tomorrow] [--protect] [--complete] [note]` | Saves a handoff, logically ends the tracked session, parks the mission, optionally starts quiet hours (asks one question if unclear). Reports each part separately. | Require the mission to be complete; claim you rested. |
| `/stopcode:resume [--override]` | Restores the latest handoff; if quiet hours are active, asks for an explicit yes before overriding. | Start implementing anything. |

Scope changes are recorded instead of silently absorbed: `stopcode scope accept "<text>"` for an
accepted addition (the original objective stays immutable), `stopcode idea add "<text>"` to park
an idea for later.

## CLI: the independent control path

Everything the skills and the dashboard do goes through `bin/stopcode.js`, which works with the
dashboard closed and Claude Code closed. Run it from inside the project, or pass `--project <path>`.

```bash
node bin/stopcode.js start "Fix login validation" --criteria "auth tests pass" --criteria "empty password rejected"
node bin/stopcode.js status                       # add --json for the full projectView
node bin/stopcode.js evidence add --kind test_run --outcome pass --summary "npm test: 4 passed" --criterion 1
node bin/stopcode.js criterion confirm 2 --note "checked by hand"      # user confirmation, not verification
node bin/stopcode.js idea add "Add a password strength meter"
node bin/stopcode.js finish --quiet 30m --protect --note "stopping for today"
node bin/stopcode.js resume                       # exit code 3 while quiet hours are active
node bin/stopcode.js resume --override            # explicit override
node bin/stopcode.js quiet status | start 2h --protect | end | override
node bin/stopcode.js break start | end | status
node bin/stopcode.js handoff list | show [id]
node bin/stopcode.js planner add --title "Walk" --type recovery --start <ISO> --end <ISO> [--allow-overlap]
node bin/stopcode.js planner ics --out planner.ics
node bin/stopcode.js doctor                       # integration self-check
node bin/stopcode.js export --out my-project.json
node bin/stopcode.js uninstall [--purge-data --yes]
```

Global options: `--project <path|id>`, `--session <id>`, `--json`, `--data-dir <path>`.
`node bin/stopcode.js help` lists everything. `bin/stopcode` (sh) and `bin/stopcode.cmd` are
thin wrappers.

## How the hooks behave

All hooks are declared in `hooks/hooks.json` and run `hooks/stopcode-hook.js`, which reads the event
JSON on stdin, calls the core, prints a JSON decision only when there is one, and always exits 0.

| Event | Behaviour |
| --- | --- |
| `SessionStart` | Starts or reopens the tracked session and injects context: the mission (unchanged), criteria status, parked ideas, quiet-hours state, the last handoff's resume context. Untracked project at startup: one sentence pointing to `/stopcode:start`. |
| `UserPromptSubmit` | During **enforced** quiet hours: blocks the prompt (except `/stopcode:resume\|status\|pause\|finish`) with the reason and the way out. Otherwise records a bounded prompt excerpt and may add *advisory* context: a scope hint when wording like "while you're at it" appears and the text is not an already-accepted addition, or a once-per-interval note after 3 h elapsed or outside working hours. Default interval 20 min; dismissible; can be disabled in Settings. |
| `PreToolUse` | During enforced quiet hours: `permissionDecision: deny` for every tool call in the project, except StopCode CLI commands `status\|resume\|quiet\|handoff\|doctor\|help\|idea\|next` without shell chaining. Otherwise no output. |
| `PostToolUse` / `PostToolUseFailure` | Bounded capture: tool name, project-relative file path for edits, a command excerpt (<= 100 chars, secrets redacted), success flag, after-hours flag, duration. Test and build commands become evidence with the outcome parsed from the output (`pass`/`fail`/`unknown`). Edits made after a passing check mark the verified criterion *stale*. |
| `Stop` | Never blocks and never asks Claude to continue; only refreshes "last seen". |
| `SessionEnd` | Best effort: logically ends the tracked session. If Claude Code is killed, the session is flagged *likely stale* after 2 h without events instead. |

**Fail-open and degraded status.** Any internal error is written to `<data>/health.json`
(`lastHookError`) and `<data>/logs/hooks.log`; the hook returns no decision. The dashboard and
`stopcode doctor` then show a **DEGRADED** note with the error rather than pretending everything
is fine. Hook timeouts are 5–15 s and the hook never blocks on model judgment.

## Quiet hours: exactly what is covered

- **Scope: one project** (its root directory, the Git top level when available). Shown with name
  and path wherever quiet hours are displayed.
- **Blocked** (only when you chose *protect* / "Block new coding actions"): new prompts and new tool
  calls in Claude Code sessions whose working directory is inside that project.
- **Not blocked:** Claude Code itself (it is not closed), commands already running, other projects,
  your editor and terminal, the dashboard, the wellness chat, and the StopCode CLI allowlist above.
  Without *protect*, quiet hours are advisory only.
- **Override:** always explicit: `/stopcode:resume` (asks yes/no), `stopcode resume --override`,
  `stopcode quiet override`, or `stopcode quiet end`. Overrides are recorded in the timeline.
- **When the interval ends** nothing starts automatically; status says "interval ended; resume when
  you choose" until you resume.
- **Calendar-driven quiet hours** exist only behind an explicit Settings toggle
  (`calendarQuietHours.enabled`) and a per-project list; then recovery and personal planner blocks
  enforce for those projects, with the same override path.
- `stopcode uninstall` ends any active quiet hours so no boundary outlives the integration.

## Storage and privacy

Everything lives in one directory, `~/.stopcode` by default (`STOPCODE_DATA_DIR` or `--data-dir`
to override; the demo uses `<repo>/.stopcode-demo`):

```
<data>/state.json                 projects, missions, sessions, settings, planner, handoff index (+ .bak)
<data>/events/<projectId>.jsonl   bounded append-only activity events per project
<data>/handoffs/<projectId>/*.md  readable handoff receipts
<data>/chat/conversations.json    wellness chat (separate from coding state)
<data>/health.json                last hook event / last hook error for the self-check
<data>/logs/hooks.log             bounded diagnostics
<data>/lock/                      cross-process mutex
```

**Stored:** prompt excerpts (<= 120 characters, secrets redacted), project-relative file paths of
edited files, command excerpts (<= 100 characters, redacted), tool names, timestamps, parsed test
summaries, what you typed into StopCode (mission, criteria, ideas, notes), planner events, the chat
conversation.
**Not stored:** file contents, full prompts, transcripts, API keys. Tool output is not stored
either, except a redacted excerpt (<= 120 characters) of the error text of a *failed* test or build
command, kept as the evidence summary.
**Never sent anywhere:** there is no telemetry; the only outbound call is the wellness chat to the
Claude API, from the backend, with your key. Redaction is best effort (common key/token formats).
**Controls:** export a project as JSON (`stopcode export`, or the dashboard), delete a project or
its session history from the dashboard, `stopcode uninstall --purge-data --yes` to delete
everything. Writes are atomic with a backup copy and recovery from corruption.

## Planner export limitations

`.ics` export (all events or one) is one-way: UTC instants (`Z`), stable `UID` per event,
`SEQUENCE` increments on edit so re-importing updates rather than duplicates in clients that
honour UID. No recurrence, no attendees, no Google/Outlook synchronisation; edits made in StopCode
after an export are not pushed anywhere, and edits in your calendar do not come back.

## Wellness chat: separation and consent

- Separate conversation document, separate system prompt, separate endpoint
  (`/api/chat/...`). It never reads the Claude Code conversation.
- It receives a StopCode summary (mission, criteria status, elapsed time, quiet state) only when
  *Share summary* is enabled in Settings. Never prompts, file names or contents.
- Replies may include suggestions (park an idea, add a recovery block, clock out). They render
  as buttons and do nothing until clicked; "Done" appears only after the action persisted.
- Your message is kept even when the API call fails, and the failure is shown with its type
  (missing credentials, auth, rate limit, timeout, network, refusal). The key stays on the backend.

## Uninstall

```bash
node bin/stopcode.js uninstall                      # ends active quiet hours, prints the steps
node bin/stopcode.js uninstall --purge-data --yes   # also deletes the data directory
```

Then stop passing `--plugin-dir` (or `claude plugin uninstall stopcode@<marketplace>` if you
installed from a marketplace). StopCode writes only to its data directory; the plugin modifies
nothing else on your machine.

## Demo

`docs/DEMO.md` is the eight-step live demo (real Claude Code, a real 2-minute boundary, a tiny
sample project with one deliberate bug). `npm run demo -- --reset --seed` prepares an isolated
data directory, prints every command with absolute paths, and starts the dashboard.
`docs/ARCHITECTURE.md` explains the moving parts; `docs/API.md` is the local API contract.

## Testing

```bash
npm test                          # node --test tests/
cd sample-project && npm test     # the demo fixture: fails 1 of 4 until the deliberate bug is fixed
claude plugin validate .
```

The suite under `tests/` targets the core through its public operations: mission/criteria/evidence
and completion rules, quiet-hours scheduling across time zones, the hook handlers with recorded
Claude Code event fixtures, handoff rendering, planner overlaps and `.ics` linting, storage
recovery, and the API contract. See the test files for the exact coverage.

### Verification status

<!-- ORCHESTRATOR: fill in before submission. Keep the two columns separate. -->

- **Verified with real Claude Code (version, date):** _to be filled in_ — which skills, which hook
  events, quiet-hours block observed, resume override observed.
- **Verified with fixtures / CLI only:** CLI walkthrough on a scratch data directory (start, status,
  evidence, idea, planner add/ics, finish `--quiet 2m --protect`, blocked UserPromptSubmit and
  PreToolUse, allow-listed CLI call, resume exit 3, resume `--override`, quiet end, handoff
  list/show, doctor, export, uninstall); sample project fail 1/4 then pass 4/4; `claude plugin
  validate .`; `scripts/demo.js --reset --seed --no-serve` and re-seed idempotency.
- **Not verified:** _to be filled in_ (for example the wellness chat without an API key on the
  demo machine).

## Known gaps

- No Google/Outlook/CalDAV sync; `.ics` export only.
- Quiet hours cover the Claude Code integration only (this plugin's hooks). Your editor, terminal,
  browser and other AI tools are untouched; a command already running is not cancelled.
- Evidence parsing recognises common runner summaries only (TAP `# pass/# fail`, Jest/pytest-style
  `N passed`/`N failed`, cargo, Go `--- FAIL`, generic `N errors`). Anything else is recorded as
  `unknown`, never as `pass`. At the time of writing, Node's default `spec` reporter output
  (`ℹ pass 4`) is not recognised, so a passing `node --test` captured by the hook is `unknown`
  until you record it explicitly.
- The wellness chat needs an Anthropic API key (a Claude Code subscription does not provide one).
- Session end is best effort: if Claude Code is killed, SessionEnd may not fire and elapsed time
  can overstate until the session is flagged stale (2 h without events). Elapsed time is time
  between events, not attention.
- Project identity is the Git top level, so a monorepo is one project. The sample project in this
  repository therefore registers as the repository itself unless the demo seed pins it.
- Secret redaction is pattern-based and best effort; do not paste credentials into prompts.
- Single user, single machine, no authentication on the local server (it binds to 127.0.0.1 and
  requires a custom header plus a same-origin check for every mutation).
- The handoff documents observed state; it is not a backup of unsaved editor buffers and it does
  not commit or stash for you.
- `--until tomorrow` needs configured working hours (default Mon–Fri 09:00–17:30 in the system
  time zone; change them in Settings).

## License

MIT — see `LICENSE`.
