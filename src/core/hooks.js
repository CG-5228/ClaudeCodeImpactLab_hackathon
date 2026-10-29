'use strict';
// Claude Code hook handlers. Contract (see code.claude.com/docs/en/hooks):
//   - input arrives as JSON on stdin; output is a single JSON object on stdout or nothing
//   - PreToolUse denies with hookSpecificOutput.permissionDecision = "deny"
//   - UserPromptSubmit blocks with top-level decision = "block"
//   - SessionStart / UserPromptSubmit add context with additionalContext
//   - Stop is a response ending, never a reason to keep the agent going
// Every handler fails open: on any internal error the hook records a visible
// degraded-enforcement note in health.json and returns no decision.
const { StopCode } = require('./domain');
const P = require('./projects');
const T = require('./time');

// Commands that must keep working while quiet hours block everything else: the StopCode
// CLI's own status/resume/quiet/handoff/doctor commands. No shell chaining allowed.
// Single line only (no CR/LF), no shell operators, no substitution characters, no leading
// environment assignments or other prefixes. Anything else is denied during quiet hours.
// Two harmless, exact suffixes are tolerated because models add them to read exit codes:
// `2>&1` and `; echo "exit=$?"` (or `; echo $?`).
const STOPCODE_CLI_ALLOW = /^[ \t]*(?:node(?:\.exe)?[ \t]+(?:"[^"\r\n]*stopcode\.js"|'[^'\r\n]*stopcode\.js'|[^\s"']*stopcode\.js)|stopcode)[ \t]+(?:status|resume|quiet|handoff|doctor|help|idea|next|pause|unpause|finish|break|--help|-h)\b[^&|;<>`$()\r\n{}]*(?:[ \t]*2>&1)?(?:[ \t]*;[ \t]*echo[ \t]+(?:"exit=\$\?"|'exit=\$\?'|exit=\$\?|\$\?))?[ \t]*$/i;
const STOPCODE_PROMPT_ALLOW = /^\s*\/stopcode:(?:resume|status|pause|finish)\b/i;
const STOPCODE_PROMPT_ANY = /^\s*\/stopcode:/i;

function stopcodeCliHint() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  return root ? `node "${root.replace(/\\/g, '/')}/bin/stopcode.js"` : 'stopcode';
}

function recordHookError(sc, eventName, err) {
  try {
    sc.store.updateHealth({ lastHookError: { at: sc.now(), event: eventName, message: String((err && err.message) || err).slice(0, 300) } });
    sc.store.log(`[${eventName}] error: ${String((err && err.stack) || err).slice(0, 600)}`);
  } catch (e) {
    /* never throw from error recording */
  }
}

function quietDenyReason(quiet, projectName, { stopcodeCommand = false } = {}) {
  const cli = stopcodeCliHint();
  const parts = [
    `StopCode quiet hours are active for project "${projectName}" until ${quiet.endsAtLocal}.`,
    'New tool actions in this project are paused by a boundary the user chose when clocking out. Do not retry this action.',
    `Tell the user their work is parked (the handoff has the next step) and that they can lift the boundary explicitly with /stopcode:resume (or \`${cli} resume --override\`), or wait until ${quiet.endsAtTime}.`,
    'The wellness chat in the StopCode dashboard still works while coding is paused.',
  ];
  if (stopcodeCommand) {
    parts.push(`StopCode's own commands do pass during quiet hours, but only as a bare single command: \`${cli} status|resume|quiet|handoff|doctor ...\` with no cd, no &&, no pipes and no redirection. Re-run it in that exact form.`);
  }
  return parts.join(' ');
}

function sessionContext(sc, res) {
  const view = sc.projectView(res.project.id);
  if (!view) return null;
  const lines = [];
  lines.push(`StopCode is tracking this project (${view.project.name}).`);
  if (view.mission) {
    lines.push(`Mission (original goal, unchanged): "${view.mission.objective}". ${view.mission.completion.headline}. Next step: ${view.mission.nextStep}.`);
    if (view.mission.criteria.length) {
      lines.push('Criteria: ' + view.mission.criteria.map((c, i) => `${i + 1}) ${c.text} [${c.status.replace('_', ' ')}${c.stale ? ', stale' : ''}]`).join('; '));
    }
    if (view.mission.parkedAt) lines.push(`The mission was parked at ${T.formatDateTime(view.mission.parkedAt, view.timezone)}; use /stopcode:resume before continuing work.`);
    const parked = view.ideas.filter((i) => i.status === 'parked');
    if (parked.length || view.additions.length) lines.push(`Parked ideas: ${parked.length}${parked.length ? ` (${parked.slice(0, 3).map((i) => i.text).join('; ')})` : ''}. Accepted additions: ${view.additions.length}.`);
  } else {
    lines.push('No active mission. /stopcode:start <goal> records the original objective and completion criteria.');
  }
  if (view.quiet.active) {
    lines.push(`Quiet hours are active until ${view.quiet.endsAtLocal}${view.quiet.protect ? '; StopCode blocks new tool actions in this project until then. The user can lift this explicitly with /stopcode:resume.' : ' (advisory, not blocking).'}`);
  }
  if (view.project.monitoring.paused) lines.push('StopCode monitoring is paused for this project (no activity capture or advice; coding is not blocked).');
  if (view.handoff && view.handoff.resumeContext) {
    lines.push('Last handoff resume context:');
    lines.push(view.handoff.resumeContext.slice(0, 700));
  }
  lines.push('StopCode skills: /stopcode:status, /stopcode:finish, /stopcode:pause, /stopcode:resume. Record scope changes instead of silently expanding the mission: `stopcode scope accept "<text>"` for accepted additions, `stopcode idea add "<text>"` to park an idea.');
  return lines.join('\n').slice(0, 2400);
}

function adviceFor(sc, state, project, mission, session, { scopeHint, afterHours }) {
  const settings = state.settings;
  if (!settings.advice || settings.advice.enabled === false) return null;
  if (!mission) return null;
  const now = T.toMs(sc.now());
  const minGap = (settings.advice.minIntervalMinutes || 20) * 60000;
  if (project.advice && project.advice.dismissedUntil && T.toMs(project.advice.dismissedUntil) > now) return null;
  if (project.advice && project.advice.lastAt && now - T.toMs(project.advice.lastAt) < minGap) return null;
  const parts = [];
  if (scopeHint === 'possible_expansion') {
    parts.push(`StopCode (advisory, not blocking): the active mission is "${mission.objective}". This prompt uses wording that often introduces work beyond the original goal. If part of it is outside that goal, record the decision instead of silently expanding: accept it with \`stopcode scope accept "<text>"\` or park it with \`stopcode idea add "<text>"\`. Necessary dependencies of the goal are in scope; only ask the user if it is genuinely unclear.`);
  }
  const elapsed = session ? now - T.toMs(session.startedAt) : 0;
  if (afterHours || elapsed > 3 * 3600000) {
    const bits = [];
    if (elapsed > 3 * 3600000) bits.push(`this coding session has ${T.humanDuration(elapsed)} of elapsed wall-clock time`);
    if (afterHours) bits.push('it is outside the working hours the user configured');
    parts.push(`StopCode (advisory): ${bits.join(' and ')}. When the current task reaches a natural stopping point, mention once that /stopcode:finish saves a handoff so the user can stop without losing their place. Do not repeat this and do not stop work on your own.`);
  }
  if (!parts.length) return null;
  return parts.join('\n');
}

function handleHook(eventName, input, { now } = {}) {
  const sc = new StopCode({ now });
  const event = eventName || input.hook_event_name;
  try {
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionId = input.session_id ? String(input.session_id) : null;
    switch (event) {
      case 'SessionStart':
        return onSessionStart(sc, input, cwd, sessionId);
      case 'UserPromptSubmit':
        return onUserPromptSubmit(sc, input, cwd, sessionId);
      case 'PreToolUse':
        return onPreToolUse(sc, input, cwd, sessionId);
      case 'PostToolUse':
        return onPostToolUse(sc, input, cwd, sessionId, true);
      case 'PostToolUseFailure':
        return onPostToolUse(sc, input, cwd, sessionId, false);
      case 'Stop':
        return onStop(sc, input, cwd, sessionId);
      case 'SessionEnd':
        return onSessionEnd(sc, input, cwd, sessionId);
      default:
        return null;
    }
  } catch (err) {
    recordHookError(sc, event, err);
    return null;
  }
}

function touchHealth(sc, event, sessionId, projectId) {
  sc.store.updateHealth({ lastHookEvent: { event, at: sc.now(), sessionId, projectId: projectId || null } });
}

function onSessionStart(sc, input, cwd, sessionId) {
  if (!sessionId) return null;
  const res = sc.sessionStart({ sessionId, source: input.source || 'startup', cwd });
  touchHealth(sc, 'SessionStart', sessionId, res.tracked ? res.project.id : null);
  if (!res.tracked) {
    if (input.source === 'startup') {
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'StopCode plugin is loaded but this project has no mission yet. If the user wants their goal tracked, /stopcode:start <goal> records it; otherwise StopCode stays quiet.' } };
    }
    return null;
  }
  const context = sessionContext(sc, res);
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : null;
}

function onUserPromptSubmit(sc, input, cwd, sessionId) {
  const state = sc.readState();
  const project = P.findProject(state, cwd);
  if (!project) return null;
  const prompt = String(input.prompt || '');
  const quiet = sc._quietStatus(state, project, sc.now());
  if (quiet.enforced && !STOPCODE_PROMPT_ALLOW.test(prompt)) {
    sc.store.update((s) => {
      sc._event(s, project.id, { id: input.prompt_id ? `prompt_blocked:${input.prompt_id}` : undefined, type: 'prompt_blocked', sessionId, reason: 'quiet_hours' });
    });
    touchHealth(sc, 'UserPromptSubmit', sessionId, project.id);
    return {
      decision: 'block',
      reason: `StopCode quiet hours are active for ${project.name} until ${quiet.endsAtLocal}. Your work is parked; the latest handoff has the next step. To lift the boundary now, run /stopcode:resume (explicit override) or \`${stopcodeCliHint()} resume --override\`. The wellness chat in the StopCode dashboard still works.`,
    };
  }
  const res = sc.recordPrompt({ sessionId, promptId: input.prompt_id, prompt, cwd });
  touchHealth(sc, 'UserPromptSubmit', sessionId, project.id);
  if (!res.tracked || res.monitoringPaused) return null;
  // StopCode's own commands never need advice about themselves.
  if (STOPCODE_PROMPT_ANY.test(prompt)) return null;
  const fresh = sc.readState();
  const freshProject = fresh.projects[project.id];
  const mission = freshProject && freshProject.activeMissionId ? fresh.missions[freshProject.activeMissionId] : null;
  const session = sessionId ? fresh.sessions[sessionId] : null;
  const advice = adviceFor(sc, fresh, freshProject, mission, session, { scopeHint: res.scopeHint, afterHours: res.afterHours });
  if (!advice) return null;
  sc.markAdvice({ project: project.id });
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: advice } };
}

function onPreToolUse(sc, input, cwd, sessionId) {
  const state = sc.readState();
  const project = P.findProject(state, cwd);
  if (!project) return null;
  const quiet = sc._quietStatus(state, project, sc.now());
  if (!quiet.enforced) return null;
  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = String(toolInput.command || '');
  const isShell = tool === 'Bash' || tool === 'PowerShell';
  if (isShell && STOPCODE_CLI_ALLOW.test(command)) return null;
  const looksLikeStopcode = isShell && /stopcode(?:\.js)?\b/i.test(command);
  sc.store.update((s) => {
    sc._event(s, project.id, { id: input.tool_use_id ? `tool_blocked:${input.tool_use_id}` : undefined, type: 'tool_blocked', sessionId, tool, reason: 'quiet_hours', command: isShell ? require('./redact').excerpt(command, 100) : undefined });
  });
  touchHealth(sc, 'PreToolUse', sessionId, project.id);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: quietDenyReason(quiet, project.name, { stopcodeCommand: looksLikeStopcode }),
    },
  };
}

function onPostToolUse(sc, input, cwd, sessionId, ok) {
  const state = sc.readState();
  const project = P.findProject(state, cwd);
  if (!project) return null;
  touchHealth(sc, ok ? 'PostToolUse' : 'PostToolUseFailure', sessionId, project.id);
  if (project.monitoring && project.monitoring.paused) return null;
  sc.recordToolEvent({
    sessionId,
    toolUseId: input.tool_use_id,
    toolName: String(input.tool_name || 'unknown'),
    toolInput: input.tool_input,
    toolResponse: input.tool_response,
    ok,
    error: input.error,
    cwd,
    durationMs: input.duration_ms,
  });
  return null;
}

function onStop(sc, input, cwd, sessionId) {
  // A response ending is not a person ending work. Never block, never ask to continue.
  const state = sc.readState();
  const project = P.findProject(state, cwd);
  if (!project) return null;
  touchHealth(sc, 'Stop', sessionId, project.id);
  if (!(project.monitoring && project.monitoring.paused)) sc.recordTurnEnd({ sessionId, cwd });
  return null;
}

function onSessionEnd(sc, input, cwd, sessionId) {
  if (!sessionId) return null;
  const res = sc.sessionEnd({ sessionId, reason: input.reason || 'other', endedBy: 'session_end' });
  touchHealth(sc, 'SessionEnd', sessionId, res.session ? res.session.projectId : null);
  return null;
}

module.exports = { handleHook, recordHookError, STOPCODE_CLI_ALLOW, STOPCODE_PROMPT_ALLOW, quietDenyReason };
