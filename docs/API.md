# StopCode local API contract

The dashboard server (`src/server/server.js`) binds to `127.0.0.1` only (default port 4821,
override with `--port` or `STOPCODE_PORT`). It serves the static dashboard from
`src/dashboard/public/` and a JSON API under `/api/`. Every mutation goes through the shared
core in `src/core/` (class `StopCode` in `domain.js`, `Planner` in `planner.js`).

## Conventions

- JSON request and response bodies. Errors: `{"error": {"type": "...", "message": "...", "field"?: "...", "details"?: ...}}`
  with HTTP 400 (ValidationError), 404 (NotFoundError), 409 (PlannerConflict, body includes
  `overlaps: [{id,title,type,start,end}]`), 503 (LockTimeoutError), 500 otherwise.
- Cross-origin protection: every non-GET request must carry the header `X-StopCode-Request: 1`.
  If an `Origin` header is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
  No CORS headers are ever sent. Response headers include `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Body limit 256 KB. Timestamps are UTC ISO strings; the server never converts them. The
  client formats with `Intl` using `timezone` from the payload.
- All project ids are the `proj_...` ids from the core; `:id` may also be an absolute path.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/overview` | | `{now, dataDir, settings, projects:[summary], breaks, health, handoffs:[...], plannerEventCount, doctor}` (`doctor` = `doctor(sc,{checkClaude:false})`) |
| GET | `/api/projects` | | `[summary]` |
| GET | `/api/projects/:id` | | `projectView` (see below) |
| POST | `/api/projects/:id/clock-out` | `{note?, quiet?: {minutes?: "30m"|number, until?: "HH:MM"|"tomorrow"|ISO, protect: bool}, markComplete?: bool}` | clockOut result `{ok, message, handoff:{ok,path,id,nextAction,resumeContext}|{ok:false,error}, session:{endedSessionIds,note}, mission?, quiet:{ok, requested?, active, protect, endsAt, endsAtLocal, ...}, errors:[...], project}` |
| POST | `/api/projects/:id/resume` | `{override?: bool}` | `{ok, blocked, quiet, mission?, handoff?: {...record, markdown}, message, overrode}` |
| POST | `/api/projects/:id/handoff` | `{note?}` | `{ok, handoff, markdown}` |
| GET | `/api/handoffs/:handoffId` | | `{handoff, markdown, missing}` |
| GET | `/api/handoffs/:handoffId/download` | | `text/markdown` attachment |
| GET | `/api/projects/:id/export` | | JSON attachment (`exportProject`) |
| DELETE | `/api/projects/:id` | | `{ok, deleted}` (removes missions, sessions, events, handoff files) |
| DELETE | `/api/projects/:id/history` | | `{ok}` (removes ended sessions + event log only) |
| POST | `/api/projects/:id/ideas` | `{text}` | `{ok, idea}` (park an idea; never starts a mission) |
| PATCH | `/api/projects/:id/ideas/:ideaId` | `{status: parked|resumed|dropped}` | `{ok, idea}` |
| POST | `/api/projects/:id/additions` | `{text}` | `{ok, addition, duplicate?}` |
| POST | `/api/projects/:id/criteria/:critId/confirm` | `{note?}` | `{ok, criterion}` (user confirmation, labelled separately) |
| POST | `/api/projects/:id/criteria/:critId/status` | `{status, note?}` | `{ok, criterion}` (verified requires passing evidence; 400 otherwise) |
| POST | `/api/projects/:id/next` | `{text}` | `{ok, nextAction}` |
| POST | `/api/projects/:id/quiet` | `{minutes?, until?, protect}` | `{ok, quiet}` |
| POST | `/api/projects/:id/quiet/override` | | `{ok, wasActive, quiet}` |
| POST | `/api/projects/:id/quiet/end` | | `{ok, quiet}` |
| POST | `/api/projects/:id/monitoring` | `{paused: bool}` | `{ok, project}` |
| POST | `/api/projects/:id/advice/dismiss` | `{minutes?}` | `{ok, dismissedUntil}` |
| POST | `/api/breaks/start` | `{note?}` | `{ok, break, alreadyOnBreak?}` |
| POST | `/api/breaks/end` | | `{ok, break, notOnBreak?}` |
| GET | `/api/settings` | | `settings` |
| PATCH | `/api/settings` | any of `{timezone, workingHours:{mon:[{start,end}],...}, calendarQuietHours:{enabled, projectIds}, chat:{shareSummary}, advice:{enabled,minIntervalMinutes}}` | `{ok, settings}` |
| GET | `/api/planner?from=ISO&to=ISO` | | `[event + overlaps:[...]]` |
| POST | `/api/planner` | `{title, type: work|recovery|personal, start, end, notes?, allowOverlap?: bool}` | `{ok, event, overlaps}`; 409 with `overlaps` when overlapping and `allowOverlap` is not true |
| PATCH | `/api/planner/:eventId` | same fields, optional, plus `allowOverlap` | `{ok, event, overlaps}` or 409 |
| DELETE | `/api/planner/:eventId` | | `{ok, removed}` |
| GET | `/api/planner.ics` | | `text/calendar` attachment of all events (`buildIcs`) |
| GET | `/api/planner/:eventId.ics` | | `text/calendar` attachment of one event |
| GET | `/api/doctor` | | `doctor(sc, {checkClaude: false})` |
| POST | `/api/doctor/test-api` | | `{ok: true, model, latencyMs}` or `{ok:false, error:{type,message}}`; records `health.api.lastTest` |
| GET | `/api/chat` | | `{conversation: {id, createdAt, messages:[...]}, configured: bool, model, shareSummary}` |
| POST | `/api/chat/messages` | `{text, projectId?}` | `{message: {id, role:"assistant", text, suggestions:[...], at, usage?}, conversation}` or HTTP 502 `{error:{type: missing_credentials|auth|rate_limit|timeout|network|refusal|bad_request|api_error, message, status?}}`; the user message is persisted even when the call fails |
| POST | `/api/chat/clear` | | `{ok, conversation}` (new empty conversation; old one deleted) |
| POST | `/api/chat/actions` | `{projectId?, action: {type: "save_idea", text} \| {type:"add_recovery_block", title, start, end, allowOverlap?} \| {type:"clock_out", quietMinutes?, protect?, note?}}` | `{ok, result, summary}`; 409 with overlaps for planner conflicts; only a 2xx here means the action persisted |

### Chat suggestion shape (from the model, validated server-side)

```json
{ "type": "save_idea", "label": "Park: dark-mode toggle", "text": "Add a dark-mode toggle" }
{ "type": "add_recovery_block", "label": "20-minute walk at 18:30", "title": "Walk", "minutesFromNow": 10, "durationMinutes": 20 }
{ "type": "clock_out", "label": "Clock out for 30 min", "quietMinutes": 30, "protect": true }
```

The dashboard renders each suggestion as a button. Nothing happens until the user clicks it;
the click calls `POST /api/chat/actions` and the UI reports "Done" or the error. For
`add_recovery_block`, the client converts `minutesFromNow`/`durationMinutes` into
`start`/`end` ISO before calling the actions endpoint.

## `projectView` (GET /api/projects/:id)

```
{
  now, timezone,
  project: {id, name, root, git, createdAt, monitoring:{paused, pausedAt}, counters, lastActivityAt},
  mission: null | {
    id, objective, status: active|completed|archived, parkedAt, startedAt, budgetMinutes, nextAction, lastEditAt,
    criteria: [{id, text, status: not_started|in_progress|reported_complete|verified|blocked, stale, note,
                userConfirmation: null|{at,note}, evidenceIds, evidence:[{id,kind,outcome,summary,source,at}]}],
    acceptedAdditions: [{id,text,at,source}], deferredIdeas: [...], scopeNotes:[...], evidence:[...],
    completion: {state: complete|reported|blocked|incomplete|no_criteria, headline, verifiedCount, total, reportedCount, blockedCount},
    nextStep, unattachedEvidence: [...], elapsedMs, userConfirmedComplete
  },
  previousMissions: [{id, objective, status, startedAt, finishedAt, archivedAt, completion}],
  session: null | {id, startedAt, lastSeenAt, status, counters:{tools,edits,commands,prompts,afterHours,failures}, files, elapsedMs, elapsedLabel, likelyStale, lastSeenAge},
  recentSessions: [{id, startedAt, endedAt, status, endedBy, durationMs, counters, files}],
  activity: {toolEventsToday, editsToday, commandsToday, afterHoursToday, promptsToday, lastEventAt, lastEventAge, skippedMalformed},
  breaks: {onBreak, currentBreak, lastBreakEndedAt, sinceLastBreakMs|null, recorded, sinceLastBreakLabel},
  quiet: {active, enforced, protect, source: clock_out|manual|calendar|null, startsAt, endsAt, endsAtLocal, endsAtTime, overriddenAt, endedAt, expired, plannedRestartAt, remainingMs, calendarEventId?, calendarEventTitle?, projectId, projectName, projectRoot},
  workingHours: {known, within, dayKey, today:[{start,end}]},
  handoff: null | {id, savedAt, trigger, path, nextAction, resumeContext, completion, note},
  handoffCount,
  ideas: [{id, text, at, status, source, missionId}], additions: [...], scopeNotes: [...],
  timeline: [ {type:'activity', from, to, count, edits, commands, failures, afterHours, files, prompts?, fromLocal, toLocal}
            | {type: mission_start|session_start|session_end|evidence|evidence_attached|idea_parked|scope_accepted|handoff_saved|clock_out|quiet_start|quiet_end|quiet_override|resume|break_start|break_end|tool_blocked|prompt_blocked|monitoring_paused|monitoring_resumed|criterion_status|criterion_confirmed|mission_complete, at, atLocal, ...fields} ],
  integration: {lastHookEvent: null|{event, at, sessionId, projectId}, lastHookAge, lastHookError, degraded, storage},
  settings: {timezone, workingHours, calendarQuietHours, clockOut:{lastQuietMinutes, lastProtect}},
  recommendation: {tone: calm|nudge, title, detail, actions: [clock_out|start_break|unpause]}
}
```

## Honesty rules the UI must follow

- "Your original goal is complete" appears only when `mission.completion.state === 'complete'`.
- Elapsed time is always labelled elapsed/wall clock, never focus time.
- Time since last break shows "unknown" when `breaks.sinceLastBreakMs === null`.
- Integration status shows "No activity observed yet" when `integration.lastHookEvent` is null;
  never a "connected" badge derived from configuration alone.
- API: `doctor.api.configured` and `doctor.api.tested` are shown separately.
- Quiet hours card shows the exact `quiet.projectName` + `quiet.projectRoot` covered.
- Chat: a suggestion button only says "Done" after the actions endpoint returned 2xx.
