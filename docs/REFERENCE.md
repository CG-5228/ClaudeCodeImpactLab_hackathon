# StopCode reference

Details behind the [README](../README.md): the full CLI, exactly what each hook does, the
quiet-hours scope, storage and privacy, planner export limits and the wellness chat's consent
model. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Local HTTP API: [API.md](API.md).

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
| `UserPromptSubmit` | During **enforced** quiet hours: blocks the prompt (except `/stopcode:resume\|status\|pause\|finish`) with the reason and the way out. Otherwise records a bounded prompt excerpt and may add *advisory* context: a scope hint when wording like "while you're at it" appears and the text is not an already-accepted addition, or, only if the user enabled *time reminders* in Settings (`advice.timeNudges`, off by default), a note after 3 h elapsed or outside working hours. At most once per interval (default 20 min); dismissible; all advice can be disabled in Settings. |
| `PreToolUse` | During enforced quiet hours: `permissionDecision: deny` for every tool call in the project, except StopCode CLI commands `status\|resume\|quiet\|handoff\|doctor\|help\|idea\|next` without shell chaining. Otherwise no output. |
| `PostToolUse` / `PostToolUseFailure` | Bounded capture: tool name, project-relative file path for edits, a command excerpt (<= 100 chars, secrets redacted), success flag, after-hours flag, duration. Test and build commands become evidence with the outcome parsed from the output (`pass`/`fail`/`unknown`). Edits made after a passing check mark the verified criterion *stale*. |
| `Stop` | Never blocks and never asks Claude to continue; only refreshes "last seen". |
| `SessionEnd` | Logically ends the tracked session. If Claude Code exits without sending SessionEnd, the session is flagged *likely stale* after 2 h without events. |

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
Claude API, from the backend, with your key. Excerpts pass through secret redaction for common
key and token formats.
**Controls:** export a project as JSON (`stopcode export`, or the dashboard), delete a project or
its session history from the dashboard, `stopcode uninstall --purge-data --yes` to delete
everything. Writes are atomic with a backup copy and recovery from corruption.

## Planner export

`.ics` export (all events or one) works with any calendar app that imports `.ics` files: UTC
instants (`Z`), a stable `UID` per event, and `SEQUENCE` increments on edit so re-importing
updates events rather than duplicating them. Export is one-way; re-export after editing in
StopCode.

## Wellness chat: separation and consent

- Separate conversation document, separate system prompt, separate endpoint
  (`/api/chat/...`). It never reads the Claude Code conversation.
- It receives a StopCode summary (mission, criteria status, elapsed time, quiet state) only when
  *Share summary* is enabled in Settings. Never prompts, file names or contents.
- Replies may include suggestions (park an idea, add a recovery block, clock out). They render
  as buttons and do nothing until clicked; "Done" appears only after the action persisted.
- Your message is kept even when the API call fails, and the failure is shown with its type
  (missing credentials, auth, rate limit, timeout, network, refusal). The key stays on the backend.
