'use strict';
// Handoff receipt: a readable Markdown document describing where the work stands.
// It documents state from available evidence; it does not invent commands, counts or
// outcomes, and it is not a backup of unsaved editor buffers.
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./time');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

// Never throws. Returns { available, branch, head, dirtyCount, dirty: [...], reason }.
function gitState(root) {
  try {
    const inside = git(['rev-parse', '--is-inside-work-tree'], root);
    if (inside !== 'true') return { available: false, reason: 'not a Git work tree' };
  } catch (e) {
    return { available: false, reason: 'Git unavailable or not a repository' };
  }
  const out = { available: true, branch: null, head: null, dirtyCount: 0, dirty: [] };
  try {
    out.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  } catch (e) {
    out.branch = null;
  }
  try {
    out.head = git(['log', '-1', '--format=%h %s'], root);
  } catch (e) {
    out.head = null;
  }
  try {
    const status = git(['status', '--porcelain'], root);
    const lines = status ? status.split('\n').filter(Boolean) : [];
    out.dirtyCount = lines.length;
    out.dirty = lines.slice(0, 15).map((l) => l.slice(3).trim());
  } catch (e) {
    out.dirtyCount = null;
  }
  return out;
}

function statusLabel(status) {
  return {
    not_started: 'not started',
    in_progress: 'in progress',
    reported_complete: 'reported complete (not verified)',
    verified: 'verified',
    blocked: 'blocked',
  }[status] || status;
}

function criterionLine(c, evidenceById, tz) {
  const parts = [`- [${c.status === 'verified' ? 'x' : ' '}] **${c.text}** — ${statusLabel(c.status)}`];
  if (c.stale) parts[0] += ' (stale: files changed after the last passing check)';
  if (c.userConfirmation) parts.push(`  - User confirmation: ${T.formatDateTime(c.userConfirmation.at, tz)}${c.userConfirmation.note ? ` — ${c.userConfirmation.note}` : ''} (labelled as user confirmation, not independent verification)`);
  for (const id of c.evidenceIds || []) {
    const ev = evidenceById.get(id);
    if (!ev) continue;
    parts.push(`  - Evidence (${ev.kind}, ${ev.outcome}) ${T.formatDateTime(ev.at, tz)} via ${ev.source}: ${ev.summary}`);
  }
  return parts.join('\n');
}

// ctx: { project, mission, sessions, evidence, unattachedEvidence, checksNotRun, files,
//        git, deferredIdeas, additions, nextAction, elapsed, now, settings, note, trigger,
//        completion, quietPlan }
function renderHandoff(ctx) {
  const tz = ctx.settings.timezone;
  const m = ctx.mission;
  const lines = [];
  const evidenceById = new Map((ctx.evidence || []).map((e) => [e.id, e]));

  lines.push(`# StopCode handoff — ${ctx.project.name}`);
  lines.push('');
  lines.push(`Saved ${T.formatDateTime(ctx.now, tz)} (${tz}) by ${ctx.trigger || 'manual'}. Your work is parked.`);
  lines.push('');
  lines.push('## Original mission');
  lines.push('');
  if (m) {
    lines.push(`> ${m.objective}`);
    lines.push('');
    lines.push(`Started ${T.formatDateTime(m.startedAt, tz)}. Mission status: **${ctx.completion.headline}** (${ctx.completion.verifiedCount} of ${ctx.completion.total} criteria verified).`);
    if (m.userConfirmedComplete) lines.push(`User marked the mission complete on ${T.formatDateTime(m.userConfirmedComplete.at, tz)} (user confirmation, labelled separately from verification).`);
  } else {
    lines.push('_No mission was recorded for this project. The notes below come from observed activity only._');
  }
  lines.push('');
  lines.push('### Accepted additions');
  lines.push('');
  if (ctx.additions && ctx.additions.length) for (const a of ctx.additions) lines.push(`- ${a.text} (accepted ${T.formatDateTime(a.at, tz)})`);
  else lines.push('- None recorded. The original objective above is unchanged.');
  lines.push('');
  lines.push('## Completion criteria and evidence');
  lines.push('');
  if (m && m.criteria.length) for (const c of m.criteria) lines.push(criterionLine(c, evidenceById, tz));
  else lines.push('- No completion criteria were recorded.');
  lines.push('');
  lines.push('### Other verification evidence this mission');
  lines.push('');
  if (ctx.unattachedEvidence && ctx.unattachedEvidence.length) {
    for (const ev of ctx.unattachedEvidence.slice(-10)) lines.push(`- (${ev.kind}, ${ev.outcome}) ${T.formatDateTime(ev.at, tz)} via ${ev.source}: ${ev.summary}`);
  } else {
    lines.push('- No additional checks were observed.');
  }
  lines.push('');
  lines.push('### Checks not run');
  lines.push('');
  if (ctx.checksNotRun && ctx.checksNotRun.length) for (const c of ctx.checksNotRun) lines.push(`- ${c}`);
  else lines.push('- Nothing to report; every recorded criterion has at least one check attached.');
  lines.push('');
  lines.push('## Files and Git state');
  lines.push('');
  if (ctx.files && ctx.files.length) {
    lines.push('Files touched during tracked sessions (from tool activity, most recent last):');
    lines.push('');
    for (const f of ctx.files.slice(-25)) lines.push(`- \`${f}\``);
  } else {
    lines.push('No file edits were observed through Claude Code hooks during tracked sessions.');
  }
  lines.push('');
  const g = ctx.git;
  if (g && g.available) {
    lines.push(`Git: branch \`${g.branch || 'unknown'}\`, last commit \`${g.head || 'unknown'}\`, ${g.dirtyCount === null ? 'working tree status unavailable' : `${g.dirtyCount} uncommitted change${g.dirtyCount === 1 ? '' : 's'}`}.`);
    if (g.dirty && g.dirty.length) {
      lines.push('');
      lines.push('Uncommitted (first 15):');
      lines.push('');
      for (const f of g.dirty) lines.push(`- \`${f}\``);
    }
    lines.push('');
    lines.push('_StopCode did not commit, stash, or reset anything. This handoff is not a backup of unsaved editor buffers._');
  } else {
    lines.push(`Git state: unavailable (${(g && g.reason) || 'unknown'}).`);
  }
  lines.push('');
  lines.push('## Deferred ideas and unresolved problems');
  lines.push('');
  const parked = (ctx.deferredIdeas || []).filter((i) => i.status === 'parked');
  if (parked.length) for (const i of parked) lines.push(`- ${i.text} (parked ${T.formatDateTime(i.at, tz)})`);
  else lines.push('- No parked ideas.');
  const blocked = m ? m.criteria.filter((c) => c.status === 'blocked') : [];
  for (const c of blocked) lines.push(`- Blocked: ${c.text}${c.note ? ` — ${c.note}` : ''}`);
  if (ctx.note) {
    lines.push('');
    lines.push(`Note at clock-out: ${ctx.note}`);
  }
  lines.push('');
  lines.push('## Next action');
  lines.push('');
  lines.push(`**${ctx.nextAction || 'Decide the next step when you resume; no next action was recorded.'}**`);
  lines.push('');
  lines.push('## Resume context');
  lines.push('');
  lines.push('```');
  lines.push(ctx.resumeContext);
  lines.push('```');
  lines.push('');
  lines.push('## Session and mission record');
  lines.push('');
  lines.push(`- Mission: ${m ? `${m.id} (${m.status})` : 'none'}`);
  lines.push(`- Coding session: ${ctx.elapsed.sessionLabel}`);
  lines.push(`- Mission wall-clock age: ${ctx.elapsed.missionLabel}`);
  lines.push(`- Sessions tracked for this mission: ${ctx.sessions.length}`);
  if (ctx.quietPlan) lines.push(`- Planned restart: ${ctx.quietPlan}`);
  lines.push('- Durations are elapsed wall-clock time between recorded events, not focused time, and not a measure of rest.');
  lines.push('');
  return lines.join('\n');
}

function buildResumeContext(ctx) {
  const tz = ctx.settings.timezone;
  const m = ctx.mission;
  const parts = [];
  parts.push(`StopCode resume context for ${ctx.project.name} (saved ${T.formatDateTime(ctx.now, tz)})`);
  if (m) {
    parts.push(`Mission: ${m.objective}`);
    parts.push(`Status: ${ctx.completion.headline}; ${ctx.completion.verifiedCount}/${ctx.completion.total} criteria verified.`);
    const open = m.criteria.filter((c) => c.status !== 'verified').map((c) => `${c.text} [${statusLabel(c.status)}]`);
    if (open.length) parts.push(`Open criteria: ${open.slice(0, 4).join('; ')}`);
  }
  parts.push(`Next action: ${ctx.nextAction || 'not recorded'}`);
  if (ctx.files && ctx.files.length) parts.push(`Recent files: ${ctx.files.slice(-6).join(', ')}`);
  if (ctx.git && ctx.git.available) parts.push(`Git: ${ctx.git.branch || '?'}, ${ctx.git.dirtyCount === null ? 'status unknown' : `${ctx.git.dirtyCount} uncommitted`}`);
  const parked = (ctx.deferredIdeas || []).filter((i) => i.status === 'parked');
  if (parked.length) parts.push(`Parked ideas (${parked.length}): ${parked.slice(0, 3).map((i) => i.text).join('; ')}`);
  return parts.join('\n');
}

function handoffFileName(now, missionId) {
  return `${String(now).replace(/[:.]/g, '-')}-${missionId || 'no-mission'}.md`;
}

module.exports = { gitState, renderHandoff, buildResumeContext, handoffFileName, statusLabel };
