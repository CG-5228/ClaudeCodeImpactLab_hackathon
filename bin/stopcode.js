#!/usr/bin/env node
'use strict';
// StopCode command-line interface. This is the independent local control path: it works
// with the dashboard closed and is what the Claude Code skills call. Every command goes
// through the shared core; nothing edits state files by hand.
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const { positional, flags } = parseArgs(argv);
if (flags['data-dir']) process.env.STOPCODE_DATA_DIR = String(flags['data-dir']);

const core = require(path.join(__dirname, '..', 'src', 'core'));
const { StopCode, Planner, PlannerConflict, buildIcs, doctor, time: T } = core;

function parseArgs(args) {
  const pos = [];
  const fl = {};
  const add = (k, v) => {
    if (fl[k] === undefined) fl[k] = v;
    else fl[k] = [].concat(fl[k], v);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        add(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !(next.startsWith('--') && next.length > 2)) {
        add(key, next);
        i++;
      } else add(key, true);
    } else pos.push(a);
  }
  return { positional: pos, flags: fl };
}

function out(text) {
  process.stdout.write(String(text).replace(/\n?$/, '\n'));
}

function json(obj) {
  out(JSON.stringify(obj, null, 2));
}

function fail(message, code = 1) {
  process.stderr.write(`stopcode: ${message}\n`);
  process.exit(code);
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

const projectRef = first(flags.project) || undefined;
const sessionId = first(flags.session) || undefined;
const wantJson = !!flags.json;

function renderStatus(view, { brief = false } = {}) {
  const tz = view.timezone;
  const L = [];
  L.push(`StopCode — ${view.project.name} (${view.project.root})`);
  if (view.mission) {
    const m = view.mission;
    const state = m.status === 'completed' ? 'completed' : m.parkedAt ? 'parked' : 'active';
    L.push(`Mission [${state}]: "${m.objective}"`);
    L.push(`  Status: ${m.completion.headline}`);
    m.criteria.forEach((c, i) => {
      const ev = c.evidence.length ? ` — evidence: ${c.evidence.map((e) => `${e.kind}/${e.outcome}`).join(', ')}` : '';
      const conf = c.userConfirmation ? ' [user-confirmed]' : '';
      L.push(`  ${i + 1}. [${c.status.replace(/_/g, ' ')}${c.stale ? ', stale' : ''}] ${c.text} (${c.id})${ev}${conf}`);
    });
    L.push(`  Next step: ${m.nextStep}`);
    if (m.budgetMinutes) L.push(`  Time budget: ${m.budgetMinutes} min; ${T.humanDuration(m.elapsedMs)} wall clock since the mission started`);
    if (view.additions.length) L.push(`  Accepted additions: ${view.additions.map((a) => a.text).join('; ')}`);
    const parked = view.ideas.filter((i) => i.status === 'parked');
    if (parked.length) L.push(`  Parked ideas: ${parked.map((i) => `${i.text} (${i.id})`).join('; ')}`);
  } else {
    L.push('Mission: none (run `stopcode start "<goal>"` or /stopcode:start)');
  }
  L.push(`Session: ${view.session ? view.session.elapsedLabel + (view.session.likelyStale ? ' — no activity for a while; Claude Code may have exited without a SessionEnd event' : '') : 'no active coding session'}`);
  L.push(`Activity today: ${view.activity.toolEventsToday} tool actions, ${view.activity.editsToday} edits, ${view.activity.afterHoursToday} after hours; last event: ${view.activity.lastEventAge || 'none observed'}`);
  L.push(`Breaks: ${view.breaks.sinceLastBreakLabel}`);
  if (view.quiet.active) L.push(`Quiet hours: active until ${view.quiet.endsAtLocal} (${view.quiet.protect ? 'blocking new tool actions in this project' : 'advisory only'}; source: ${view.quiet.source})`);
  else if (view.quiet.expired) L.push(`Quiet hours: interval ended at ${view.quiet.endsAtLocal}; resume when you choose (nothing starts automatically)`);
  else if (view.quiet.overriddenAt) L.push(`Quiet hours: overridden at ${T.formatDateTime(view.quiet.overriddenAt, tz)}`);
  else L.push('Quiet hours: not active');
  L.push(`Monitoring: ${view.project.monitoring.paused ? `paused since ${T.formatDateTime(view.project.monitoring.pausedAt, tz)} (coding is not blocked)` : 'active'}`);
  if (view.handoff) L.push(`Last handoff: ${T.formatDateTime(view.handoff.savedAt, tz)} — ${view.handoff.path}`);
  const integ = view.integration;
  L.push(`Integration: ${integ.lastHookEvent ? `last hook event ${integ.lastHookEvent.event} ${integ.lastHookAge}` : 'no hook events observed yet'}${integ.degraded ? ` — DEGRADED: ${integ.lastHookError.message}` : ''}`);
  if (!brief) L.push(`Recommendation: ${view.recommendation.title} — ${view.recommendation.detail}`);
  return L.join('\n');
}

function renderClockOut(res) {
  const L = [];
  if (res.handoff) L.push(res.handoff.ok ? `Handoff: saved → ${res.handoff.path}` : `Handoff: FAILED — ${res.handoff.error}`);
  if (res.session) L.push(`Session: ${res.session.endedSessionIds.length ? `tracked session ended (${res.session.endedSessionIds.join(', ')})` : 'no active tracked session to end'}; the Claude Code process is not closed by StopCode`);
  if (res.mission) L.push(`Mission: ${res.mission.status === 'completed' ? 'completed (user confirmed)' : 'parked'} — ${res.mission.completion.headline}`);
  if (res.quiet) {
    if (res.quiet.requested === false) L.push('Quiet hours: not requested (advisory stop only)');
    else if (res.quiet.ok) L.push(`Quiet hours: active until ${res.quiet.endsAtLocal} — ${res.quiet.protect ? `blocking new tool actions in ${res.project.name}` : 'advisory only (no blocking)'}`);
    else L.push(`Quiet hours: FAILED — ${res.quiet.error}`);
  }
  if (res.handoff && res.handoff.ok && res.handoff.nextAction) L.push(`Next action when you return: ${res.handoff.nextAction}`);
  L.push(res.message);
  return L.join('\n');
}

function renderDoctor(d) {
  const L = [];
  L.push(`StopCode self-check (${T.formatDateTime(d.now, Intl.DateTimeFormat().resolvedOptions().timeZone)})`);
  L.push(`Data directory: ${d.dataDir}`);
  L.push(`Storage: ${d.storage.writable ? 'writable' : `NOT writable (${d.storage.error})`}; state ${d.storage.stateReadable ? 'readable' : `unreadable (${d.storage.stateError})`}${d.storage.lastRecovery ? `; recovered from ${d.storage.lastRecovery.from} at ${d.storage.lastRecovery.at}` : ''}`);
  L.push(`Hooks: ${d.hooks.observed ? `last real event ${d.hooks.lastEvent.event} ${d.hooks.lastEventAge}` : 'no hook event observed yet (start Claude Code with the plugin loaded)'}${d.hooks.degraded ? ` — DEGRADED: ${d.hooks.lastError.message}` : ''}`);
  L.push(`Plugin: ${d.plugin.files.manifest && d.plugin.files.hooksJson && d.plugin.files.hookScript ? 'files present' : 'files MISSING'} (skills: ${d.plugin.files.skills.join(', ') || 'none'}); load with: ${d.plugin.loadCommand}`);
  if (d.plugin.claudeVersion) L.push(`Claude Code: ${d.plugin.claudeVersion}`);
  L.push(`API: ${d.api.configured ? `configured via ${d.api.source}` : 'not configured'}; ${d.api.tested ? 'connection tested successfully' : 'not tested successfully'} (model ${d.api.model}). ${d.api.note}`);
  if (d.quietHours.project) L.push(`Quiet hours scope: project "${d.quietHours.project}" at ${d.quietHours.root}: ${d.quietHours.active ? `ACTIVE until ${d.quietHours.endsAtLocal}${d.quietHours.protect ? ' (blocking)' : ' (advisory)'}` : 'not active'}`);
  else L.push(`Quiet hours scope: ${d.quietHours.note}`);
  return L.join('\n');
}

const HELP = `StopCode — know when to exit the loop.

Usage: stopcode <command> [options]

Mission
  start "<objective>" [--criteria "<text>"]... [--budget <minutes>]   record the original goal and begin tracking
  status [--brief]                                                 mission, evidence, elapsed time, boundary state
  next "<text>"                                                    set the one clear next action
  criterion add "<text>" | status <id|n> <state> [--note ..] | confirm <id|n> [--note ..]
  evidence add --kind <test_run|build|command|manual_check|note> --outcome <pass|fail|unknown> --summary ".." [--criterion <id|n>]
  evidence list
  scope accept "<text>"            record an accepted addition (the original objective stays immutable)
  scope note "<text>" --class <in_scope|necessary_dependency|optional_improvement|scope_expansion|unrelated|uncertain> [--decision noted|accepted|deferred|dismissed]
  idea add "<text>" | idea list | idea set <id> <parked|resumed|dropped>
  complete [--note ..]             user confirmation that the mission is done (labelled separately from verification)

Boundaries
  finish [--quiet <30m|2h>] [--until <HH:MM|tomorrow>] [--protect] [--note ".."] [--complete]
                                   save a handoff, end the tracked session, optionally start quiet hours
  resume [--override]              restore the handoff; --override lifts active quiet hours explicitly
  pause | unpause                  pause/resume monitoring and advice (does not block or unblock coding)
  quiet status | start <dur> [--protect] [--until ..] | end | override
  break start | end | status
  handoff save [--note ".."] | show [id] | list

System
  doctor                           integration self-check
  serve [--port 4821] [--open]     start the local dashboard
  export [--out <file>]            export this project's StopCode data as JSON
  uninstall [--purge-data --yes]   how to remove the integration; optionally delete the data directory
  hook <EventName>                 (internal) run a hook handler with JSON on stdin

Global options: --project <path|id>  --session <id>  --json  --data-dir <path>
Data directory: ${process.env.STOPCODE_DATA_DIR || '~/.stopcode'} (override with STOPCODE_DATA_DIR)`;

function main() {
  const cmd = positional[0];
  const sub = positional[1];
  if (!cmd || cmd === 'help' || flags.help || flags.h) return out(HELP);
  const sc = new StopCode();

  switch (cmd) {
    case 'start': {
      const objective = positional.slice(1).join(' ');
      const criteria = flags.criteria ? [].concat(flags.criteria) : [];
      const res = sc.startMission({ project: projectRef, objective, criteria, budgetMinutes: first(flags.budget), sessionId });
      if (wantJson) return json(res);
      const L = [`Mission started for ${res.project.name}: "${res.mission.objective}"`];
      res.mission.criteria.forEach((c, i) => L.push(`  ${i + 1}. ${c.text} (${c.id})`));
      if (!res.mission.criteria.length) L.push('  (no criteria yet — add with: stopcode criterion add "<text>")');
      if (res.mission.budgetMinutes) L.push(`  Time budget: ${res.mission.budgetMinutes} min (advisory)`);
      if (res.previousMission) L.push(`Previous mission preserved in history: "${res.previousMission.objective}"`);
      L.push('Tracking has begun. Status: stopcode status · Stop for the day: stopcode finish');
      return out(L.join('\n'));
    }
    case 'status': {
      const view = sc.projectView(projectRef);
      if (!view) fail(`no StopCode project for ${projectRef || process.cwd()}; run \`stopcode start "<goal>"\` first`, 2);
      if (wantJson) return json(view);
      return out(renderStatus(view, { brief: !!flags.brief }));
    }
    case 'next': {
      const res = sc.setNextAction({ project: projectRef, text: positional.slice(1).join(' ') });
      return wantJson ? json(res) : out(`Next action set: ${res.nextAction}`);
    }
    case 'complete': {
      const res = sc.completeMission({ project: projectRef, note: first(flags.note) });
      return wantJson ? json(res) : out('Mission marked complete by you (recorded as user confirmation, separate from verification evidence).');
    }
    case 'criterion': {
      if (sub === 'add') {
        const res = sc.addCriterion({ project: projectRef, text: positional.slice(2).join(' ') });
        return wantJson ? json(res) : out(`Criterion added: ${res.criterion.text} (${res.criterion.id})`);
      }
      if (sub === 'status') {
        const res = sc.setCriterionStatus({ project: projectRef, criterion: positional[2], status: positional[3], note: first(flags.note) });
        return wantJson ? json(res) : out(`Criterion "${res.criterion.text}" is now ${res.criterion.status.replace(/_/g, ' ')}`);
      }
      if (sub === 'confirm') {
        const res = sc.confirmCriterion({ project: projectRef, criterion: positional[2], note: first(flags.note) });
        return wantJson ? json(res) : out(`User confirmation recorded for "${res.criterion.text}" (status: ${res.criterion.status.replace(/_/g, ' ')}; this is labelled as user confirmation, not verification)`);
      }
      return fail('usage: criterion add|status|confirm');
    }
    case 'evidence': {
      if (sub === 'add') {
        const res = sc.addEvidence({ project: projectRef, kind: first(flags.kind), outcome: first(flags.outcome) || 'unknown', summary: first(flags.summary) || positional.slice(2).join(' '), criterion: first(flags.criterion), source: 'skill', sessionId });
        if (wantJson) return json(res);
        return out(`Evidence recorded: ${res.evidence.kind}/${res.evidence.outcome} (${res.evidence.id})${res.criterion ? ` → criterion "${res.criterion.text}" is now ${res.criterion.status.replace(/_/g, ' ')}` : ''}`);
      }
      if (sub === 'list') {
        const view = sc.projectView(projectRef);
        if (!view || !view.mission) fail('no active mission', 2);
        if (wantJson) return json(view.mission.evidence);
        if (!view.mission.evidence.length) return out('No evidence recorded yet.');
        return out(view.mission.evidence.map((e) => `${e.id} ${T.formatDateTime(e.at, view.timezone)} ${e.kind}/${e.outcome} via ${e.source}: ${e.summary}${e.criterionIds.length ? ` [${e.criterionIds.join(',')}]` : ''}`).join('\n'));
      }
      if (sub === 'attach') {
        const res = sc.attachEvidence({ project: projectRef, criterion: positional[2], evidenceId: positional[3] });
        return wantJson ? json(res) : out(`Attached ${res.evidence.id} to "${res.criterion.text}" (now ${res.criterion.status.replace(/_/g, ' ')})`);
      }
      return fail('usage: evidence add|list|attach');
    }
    case 'scope': {
      if (sub === 'accept') {
        const res = sc.acceptAddition({ project: projectRef, text: positional.slice(2).join(' '), source: 'user' });
        return wantJson ? json(res) : out(res.duplicate ? 'Already accepted.' : `Accepted as an addition (original objective unchanged): ${res.addition.text}`);
      }
      if (sub === 'note') {
        const res = sc.noteScope({ project: projectRef, text: positional.slice(2).join(' '), classification: first(flags.class), decision: first(flags.decision) || 'noted', source: 'claude' });
        return wantJson ? json(res) : out(`Scope note recorded: ${res.note.classification} / ${res.note.decision}`);
      }
      return fail('usage: scope accept|note');
    }
    case 'idea': {
      if (sub === 'add') {
        const res = sc.parkIdea({ project: projectRef, text: positional.slice(2).join(' ') });
        return wantJson ? json(res) : out(`Parked: ${res.idea.text} (${res.idea.id}). No new mission was started.`);
      }
      if (sub === 'list') {
        const view = sc.projectView(projectRef);
        if (!view) fail('no StopCode project here', 2);
        if (wantJson) return json(view.ideas);
        return out(view.ideas.length ? view.ideas.map((i) => `${i.id} [${i.status}] ${i.text}`).join('\n') : 'No parked ideas.');
      }
      if (sub === 'set') {
        const res = sc.updateIdea({ project: projectRef, ideaId: positional[2], status: positional[3] });
        return wantJson ? json(res) : out(`Idea ${res.idea.id} is now ${res.idea.status}`);
      }
      return fail('usage: idea add|list|set');
    }
    case 'finish': {
      const quietArg = first(flags.quiet);
      const until = first(flags.until);
      const quiet = quietArg || until ? { minutes: quietArg === true ? undefined : quietArg, until: until === true ? undefined : until, protect: !!flags.protect } : null;
      if (quiet && quietArg === true && !until) fail('--quiet needs a duration, e.g. --quiet 30m');
      const res = sc.clockOut({ project: projectRef, sessionId, note: first(flags.note), quiet, trigger: 'finish', markComplete: !!flags.complete });
      if (wantJson) return json(res);
      out(renderClockOut(res));
      if (!res.ok) process.exit(1);
      return undefined;
    }
    case 'resume': {
      const res = sc.resume({ project: projectRef, override: !!flags.override, sessionId });
      if (wantJson) return json(res);
      if (res.blocked) {
        out(`${res.message}\nTo lift the boundary explicitly: stopcode resume --override`);
        process.exit(3);
      }
      const L = [res.message];
      if (res.overrode) L.push('Quiet hours were overridden explicitly for this project.');
      if (res.handoff) {
        L.push(`Handoff (${T.formatDateTime(res.handoff.savedAt, sc.settings().timezone)}): ${res.handoff.path}`);
        L.push('--- resume context ---');
        L.push(res.handoff.resumeContext || '(none)');
      } else L.push('No saved handoff for this project yet.');
      L.push('Nothing was started automatically.');
      return out(L.join('\n'));
    }
    case 'pause': {
      const res = sc.pauseMonitoring({ project: projectRef });
      if (wantJson) return json(res);
      return out(`Monitoring paused for ${res.project.name}. Activity capture and advice are off; coding is not blocked. This does not close Claude Code${res.quiet.active ? ` and does not lift the quiet-hours boundary (active until ${res.quiet.endsAtLocal})` : ''}. Resume with: stopcode unpause`);
    }
    case 'unpause': {
      const res = sc.resumeMonitoring({ project: projectRef });
      return wantJson ? json(res) : out(`Monitoring resumed for ${res.project.name}.`);
    }
    case 'quiet': {
      if (!sub || sub === 'status') {
        const q = sc.quietStatus({ project: projectRef });
        if (wantJson) return json(q);
        if (!q.tracked) return out('No StopCode project for this directory.');
        return out(q.active ? `Quiet hours active for ${q.projectName} until ${q.endsAtLocal} (${q.protect ? 'blocking new tool actions' : 'advisory'}; source ${q.source})` : q.expired ? `Quiet interval ended at ${q.endsAtLocal}; resume when you choose.` : 'Quiet hours not active.');
      }
      if (sub === 'start') {
        const res = sc.startQuiet({ project: projectRef, minutes: positional[2], until: first(flags.until), protect: !!flags.protect, reason: 'manual' });
        return wantJson ? json(res) : out(`Quiet hours active until ${res.quiet.endsAtLocal} (${res.quiet.protect ? 'blocking new tool actions in this project' : 'advisory only'})`);
      }
      if (sub === 'end') {
        const res = sc.endQuiet({ project: projectRef, by: 'user' });
        return wantJson ? json(res) : out('Quiet hours ended for this project.');
      }
      if (sub === 'override') {
        const res = sc.overrideQuiet({ project: projectRef });
        return wantJson ? json(res) : out(res.wasActive ? 'Quiet hours overridden explicitly for this project.' : 'No active quiet hours to override.');
      }
      return fail('usage: quiet status|start|end|override');
    }
    case 'break': {
      if (sub === 'start') {
        const res = sc.startBreak({ note: first(flags.note) });
        return wantJson ? json(res) : out(res.alreadyOnBreak ? `Already on a break since ${res.break.startedAt}` : `Break started at ${T.formatTime(res.break.startedAt, sc.settings().timezone)}. End it with: stopcode break end`);
      }
      if (sub === 'end') {
        const res = sc.endBreak();
        return wantJson ? json(res) : out(res.notOnBreak ? 'No break in progress.' : `Break ended (${T.humanDuration(T.toMs(res.break.endedAt) - T.toMs(res.break.startedAt))}).`);
      }
      const o = sc.overview();
      return wantJson ? json(o.breaks) : out(o.breaks.onBreak ? `On a break since ${T.formatTime(o.breaks.currentBreak.startedAt, o.settings.timezone)}` : o.breaks.sinceLastBreakMs === null ? 'No break recorded yet (unknown).' : `Last recorded break ended ${T.humanDuration(o.breaks.sinceLastBreakMs)} ago.`);
    }
    case 'handoff': {
      if (!sub || sub === 'save') {
        const res = sc.saveHandoff({ project: projectRef, note: first(flags.note), trigger: 'manual', sessionId });
        return wantJson ? json(res.handoff) : out(`Handoff saved → ${res.handoff.path}\nNext action: ${res.handoff.nextAction}`);
      }
      if (sub === 'show') {
        let id = positional[2];
        if (!id) {
          const project = sc.requireProject(projectRef);
          const latest = sc.latestHandoff(project.id);
          if (!latest) fail('no handoff saved yet', 2);
          id = latest.id;
        }
        const res = sc.readHandoff(id);
        if (wantJson) return json(res);
        return out(res.missing ? `Handoff record ${id} exists but its file is missing: ${res.handoff.path}` : res.markdown);
      }
      if (sub === 'list') {
        const list = sc.listHandoffs({ project: projectRef });
        if (wantJson) return json(list);
        return out(list.length ? list.map((h) => `${h.id} ${h.savedAt} ${h.trigger} ${h.path}`).join('\n') : 'No handoffs yet.');
      }
      return fail('usage: handoff save|show|list');
    }
    case 'doctor': {
      const d = doctor(sc, { projectRef });
      return wantJson ? json(d) : out(renderDoctor(d));
    }
    case 'serve': {
      const { startServer } = require(path.join(__dirname, '..', 'src', 'server', 'server.js'));
      return startServer({ port: Number(first(flags.port)) || Number(process.env.STOPCODE_PORT) || 4821, open: !!flags.open }).then((info) => {
        out(`StopCode dashboard: ${info.url}  (data: ${sc.dataDir})\nPress Ctrl+C to stop.`);
      });
    }
    case 'export': {
      const project = sc.requireProject(projectRef);
      const bundle = sc.exportProject(project.id);
      const target = first(flags.out);
      if (target) {
        fs.writeFileSync(path.resolve(String(target)), JSON.stringify(bundle, null, 2));
        return out(`Exported ${project.name} to ${path.resolve(String(target))}`);
      }
      return json(bundle);
    }
    case 'uninstall': {
      const ended = sc.endAllQuiet();
      const L = [
        'StopCode uninstall',
        ended.length ? `Ended active quiet hours for: ${ended.join(', ')} (so no boundary outlives the integration).` : 'No active quiet hours to end.',
        '1. If you load the plugin with `claude --plugin-dir <path>`, simply stop passing the flag.',
        '2. If you installed it from a marketplace: `claude plugin uninstall stopcode@<marketplace>` (or disable it in /plugin).',
        `3. Your data lives in ${sc.dataDir}. It is not deleted unless you ask: stopcode uninstall --purge-data --yes`,
      ];
      if (flags['purge-data']) {
        if (!flags.yes) L.push('Data NOT deleted: add --yes to confirm deletion of the data directory.');
        else {
          fs.rmSync(sc.dataDir, { recursive: true, force: true });
          L.push(`Deleted ${sc.dataDir}.`);
        }
      }
      return out(L.join('\n'));
    }
    case 'hook': {
      let raw = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        raw += c;
      });
      process.stdin.on('end', () => {
        let input = {};
        try {
          input = raw.trim() ? JSON.parse(raw) : {};
        } catch (e) {
          input = {};
        }
        const res = core.handleHook(sub || input.hook_event_name, input);
        if (res) process.stdout.write(JSON.stringify(res));
        process.exit(0);
      });
      return undefined;
    }
    case 'planner': {
      const planner = new Planner(sc);
      if (sub === 'list') return json(planner.list());
      if (sub === 'add') {
        try {
          const res = planner.create({ title: first(flags.title), type: first(flags.type) || 'recovery', start: first(flags.start), end: first(flags.end), notes: first(flags.notes) }, { allowOverlap: !!flags['allow-overlap'] });
          return wantJson ? json(res) : out(`Planned ${res.event.type} block "${res.event.title}" ${res.event.start} → ${res.event.end} (${res.event.id})`);
        } catch (e) {
          if (e instanceof PlannerConflict) fail(`${e.message} Overlaps: ${e.overlaps.map((o) => `${o.title} (${o.start}–${o.end})`).join('; ')}. Re-run with --allow-overlap to keep both.`);
          throw e;
        }
      }
      if (sub === 'remove') return json(planner.remove(positional[2]));
      if (sub === 'ics') {
        const text = buildIcs(planner.list(), { timezone: sc.settings().timezone, now: sc.now() });
        const target = first(flags.out);
        if (target) {
          fs.writeFileSync(path.resolve(String(target)), text);
          return out(`Wrote ${path.resolve(String(target))}`);
        }
        return process.stdout.write(text);
      }
      return fail('usage: planner list|add|remove|ics');
    }
    default:
      return fail(`unknown command "${cmd}". Run: stopcode help`);
  }
}

try {
  const r = main();
  if (r && typeof r.then === 'function') r.catch((e) => fail(e.message || String(e)));
} catch (e) {
  if (e && e.name === 'ValidationError') fail(e.message, 2);
  if (e && e.name === 'NotFoundError') fail(e.message, 2);
  if (e && e.name === 'PlannerConflict') fail(`${e.message} ${JSON.stringify(e.overlaps)}`, 2);
  fail(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
}
