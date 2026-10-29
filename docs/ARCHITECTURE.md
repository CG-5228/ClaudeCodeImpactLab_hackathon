# StopCode architecture

Local-first, CommonJS, no build step, one runtime dependency (`@anthropic-ai/sdk`, used only
by the wellness chat backend). Every surface (hooks, CLI, skills, dashboard API) calls the same
core; nothing else writes state.

## Directory map

```
.claude-plugin/plugin.json   plugin manifest (name, description, keywords)
hooks/hooks.json             hook wiring: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
                             PostToolUseFailure, Stop, SessionEnd -> node hooks/stopcode-hook.js <Event>
hooks/stopcode-hook.js       single hook entry: stdin JSON -> core.handleHook -> JSON decision or nothing; exit 0 always
skills/<name>/SKILL.md       /stopcode:start, status, pause, finish, resume (each runs one CLI command)
bin/stopcode.js              CLI (independent control path; what the skills call). bin/stopcode, bin/stopcode.cmd wrappers
src/core/domain.js           class StopCode: missions, criteria, evidence, scope, sessions, breaks, quiet hours,
                             handoffs, clockOut/resume, projectView/overview, settings, export/delete
src/core/hooks.js            hook handlers (fail open), quiet-hours deny/block logic, CLI allowlist, advice
src/core/store.js            lock dir mutex, atomic JSON writes + .bak recovery, bounded event log, health, chat doc
src/core/state.js            schema defaults + migration          src/core/paths.js     data directory layout
src/core/planner.js          Planner + PlannerConflict             src/core/ics.js       buildIcs / lintIcs
src/core/handoff.js          handoff Markdown + resume context + Git state (execFile)
src/core/projects.js         project identity (Git top level via execFile), relative paths
src/core/time.js             Intl-based time-zone math             src/core/validate.js  ValidationError + validators
src/core/redact.js           best-effort secret redaction for excerpts
src/core/doctor.js           self-check (storage, hooks observed, plugin files, API configured vs tested)
src/server/server.js         HTTP server: static dashboard + /api (docs/API.md), chat backend, CSRF/CSP
src/dashboard/public/        dashboard (Today, Planner, Chat, Settings), design tokens from docs/DESIGN.md
scripts/demo.js              isolated demo environment (.stopcode-demo), seed, steps, launcher
sample-project/              tiny Node project with one deliberate bug for the live demo
tests/                       node --test suite             docs/                 API, DESIGN, DEMO, ARCHITECTURE
```

## State separation

Five concerns are stored and displayed independently; any combination is legal (for example an
incomplete mission, a saved handoff and active quiet hours at the same time).

| Concern | Where | Meaning |
| --- | --- | --- |
| **Mission completion** | `missions[id].criteria[].status`, `evidence[]`, `userConfirmedComplete`; derived `completion.state` (`complete`, `reported`, `blocked`, `incomplete`, `no_criteria`) | `complete` only when every criterion is `verified` with non-stale passing evidence. User confirmation is a separate field and label. |
| **Session lifecycle** | `sessions[id].status` (`active`/`ended`), `startedAt`, `lastSeenAt`, `endedBy` | Driven by SessionStart/SessionEnd and by clock-out (`endedBy: finish/clock_out`). A session is *likely stale* after 2 h without events. |
| **Monitoring paused** | `projects[id].monitoring.paused` | Stops activity capture and advice. Never blocks and never unblocks anything. |
| **Quiet hours** | `projects[id].quiet` (`startsAt`, `endsAt`, `protect`, `overriddenAt`, `endedAt`, `reason`), `calendarOverrides`, `settings.calendarQuietHours` | `active` = inside the interval and not ended/overridden; `enforced` = `active && protect`. Only `enforced` blocks. |
| **Handoff saved** | `handoffs[]` index + Markdown files under `handoffs/<projectId>/` | Exists whenever the user saved one; independent of completion. Resume restores the latest. |

Scope is also explicit: the objective is immutable; `acceptedAdditions[]` and `deferredIdeas[]`
record what was added or parked, `scopeNotes[]` records classifications.

## Data flow

```
Claude Code ──hook JSON (stdin)──> hooks/stopcode-hook.js ──> core.handleHook (src/core/hooks.js)
                                                                  │  StopCode operations, each inside
                                                                  │  store.update(): lock -> read -> mutate -> atomic write
                                                                  ▼
                             <data>/state.json  <data>/events/<project>.jsonl  <data>/health.json  <data>/handoffs/
                                                                  ▲
/stopcode:* skills ──> bin/stopcode.js ─────────────────────────> │  (same operations)
Dashboard UI ──fetch /api──> src/server/server.js ──────────────> │  (same operations; reads projectView/overview)
Wellness chat UI ──> /api/chat ──> server ──> Claude API (key from env/.env, backend only)
```

Hook stdout carries only the JSON decision; diagnostics go to `<data>/logs/hooks.log`. Event
records are small (type, timestamp, tool, relative file, redacted excerpt); the dashboard builds
the timeline from them and groups consecutive tool events into activity blocks.

## Quiet-hours decision path

For every `UserPromptSubmit` and `PreToolUse` event:

1. Resolve the project from the hook `cwd`: the longest registered root that contains it. No
   project -> no output (StopCode is silent in untracked directories).
2. `quietStatus(project, now)`:
   - clock-out/manual interval: active if `startsAt <= now < endsAt` and neither `endedAt` nor
     `overriddenAt` is set; expired if `now >= endsAt` (nothing restarts automatically);
   - otherwise, if `settings.calendarQuietHours.enabled` and the project id is listed, the first
     `recovery`/`personal` planner event covering `now` that has no per-event override makes quiet
     hours active with `protect = true`;
   - `enforced = active && protect`.
3. Not enforced -> fall through to normal capture/advice.
4. Enforced:
   - `UserPromptSubmit`: allow `/stopcode:resume|status|pause|finish`; otherwise record
     `prompt_blocked` and return `{ decision: "block", reason }` with the end time and the override path.
   - `PreToolUse`: allow a Bash/PowerShell command that is exactly a StopCode CLI
     `status|resume|quiet|handoff|doctor|help|idea|next` call without `& | ; < > \` $`; otherwise
     record `tool_blocked` and return `permissionDecision: "deny"` with a reason that tells Claude
     not to retry and to point the user to `/stopcode:resume`.
5. Lifting the boundary is always an explicit user action: `resume --override`, `quiet override`,
   `quiet end`, or `uninstall` (which ends all active intervals). Each is recorded as an event.
6. Any exception anywhere above is caught: the error is written to `health.json`, the hook returns
   nothing, and the dashboard/doctor show DEGRADED. Failing open is deliberate; StopCode must never
   lock a user out by accident.

## Security notes

- **Localhost only.** The server binds to `127.0.0.1` (default port 4821). No CORS headers are
  ever sent.
- **Cross-origin protection.** Every non-GET request must carry `X-StopCode-Request: 1`; if an
  `Origin` header is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
  Request bodies are capped at 256 KB.
- **CSP.** `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
  connect-src 'self'`, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
  No web fonts or external assets; the dashboard makes no external requests.
- **No shell interpolation.** Git is invoked with `execFile`/`execFileSync` and argument arrays
  (`projects.js`, `handoff.js`); the only shell invocation is the fixed string `claude --version`
  in `doctor.js`. User text is never passed to a shell. Hooks are declared with `command: node` and
  an `args` array, so plugin paths with spaces are safe.
- **Credentials.** `ANTHROPIC_API_KEY` is read by the server from the environment or `.env`
  (git-ignored). It is never written to state, logs or API responses; the dashboard only learns
  `configured: true/false` and the result of an explicit test call.
- **Bounded, redacted capture.** Prompt excerpts <= 120 chars and command excerpts <= 100 chars pass
  through `redact.js`; file paths are stored relative to the project root; no file contents or
  tool outputs are stored. Event logs, hook logs, sessions and evidence lists are size-bounded.
- **Path containment.** Handoff files are read only from inside `<data>/handoffs/`; writes are
  atomic (temp file + rename) with a `.bak` copy and corruption recovery.
- **Cross-process safety.** A lock directory serialises hook, CLI and server writes
  (stale locks are reclaimed after 15 s; waits time out after 8 s with a 503-style error).
