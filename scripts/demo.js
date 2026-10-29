#!/usr/bin/env node
'use strict';
// StopCode live-demo launcher.
//
// Prepares an ISOLATED data directory at <repo>/.stopcode-demo (never ~/.stopcode),
// optionally seeds a realistic baseline through the real core, prints the eight demo
// steps with their exact commands, and starts the dashboard on that data directory.
//
//   node scripts/demo.js              prepare, print the steps, start the dashboard
//   node scripts/demo.js --seed       also create the baseline (project, mission, recovery block)
//   node scripts/demo.js --reset      wipe .stopcode-demo first (combine with --seed to start clean)
//   node scripts/demo.js --no-open    do not open a browser tab
//   node scripts/demo.js --no-serve   prepare and print only; do not start the dashboard
//   node scripts/demo.js --port 4821  dashboard port (default 4821)
//
// Honesty rules honoured here: the seed creates only what a user could have typed
// (a mission, two criteria, one planner block). It never fabricates hook activity, test
// evidence, breaks or "connected" state; those appear only when real Claude Code hooks fire.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.join(REPO_ROOT, '.stopcode-demo');
const SAMPLE_DIR = path.join(REPO_ROOT, 'sample-project');
const DEFAULT_PORT = 4821;

const MISSION = 'Fix login validation so empty passwords are rejected';
const CRITERIA = ['auth tests pass (npm test in sample-project)', 'an empty password is rejected with code empty_password'];
const RECOVERY_TITLE = 'Recovery: walk, no screens';

// ---------- small helpers ----------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'port' && next !== undefined && !next.startsWith('--')) {
      flags.port = Number(next);
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

// Case-insensitive, slash-normalised comparison key for paths (Windows-safe).
function pathKey(p) {
  let r = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase().replace(/\\/g, '/');
  return r;
}

function isSameOrInside(parent, child) {
  const a = pathKey(parent);
  const b = pathKey(child);
  return b === a || b.startsWith(a + '/');
}

// Forward-slash form for the Git Bash launch line (Git Bash accepts C:/... paths).
function fwd(p) {
  return p.replace(/\\/g, '/');
}

// PowerShell single-quoted literal: double any embedded single quote.
function psq(p) {
  return "'" + p.replace(/'/g, "''") + "'";
}

function out(line) {
  process.stdout.write((line === undefined ? '' : line) + '\n');
}

function fail(message, code) {
  process.stderr.write('demo: ' + message + '\n');
  process.exit(code === undefined ? 2 : code);
}

// ---------- 1. isolation guard ----------

const flags = parseFlags(process.argv.slice(2));
const realDataDir = path.join(os.homedir(), '.stopcode');

if (isSameOrInside(realDataDir, DEMO_DIR) || isSameOrInside(DEMO_DIR, realDataDir)) {
  fail('refusing to run: the demo data directory (' + DEMO_DIR + ') would overlap your real StopCode data (' + realDataDir + '). Move the repository out of ~/.stopcode.');
}
if (flags.reset && (path.basename(DEMO_DIR) !== '.stopcode-demo' || !isSameOrInside(REPO_ROOT, DEMO_DIR))) {
  fail('refusing to reset: the demo directory is not <repo>/.stopcode-demo');
}

const previousEnv = process.env.STOPCODE_DATA_DIR;
if (previousEnv && pathKey(previousEnv) !== pathKey(DEMO_DIR)) {
  out('Note: STOPCODE_DATA_DIR was set to ' + previousEnv + '; the demo uses its own directory instead for this process.');
}
// Must be set before the core is required: the Store reads it when constructed.
process.env.STOPCODE_DATA_DIR = DEMO_DIR;

if (flags.reset) {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  out('Reset: removed ' + DEMO_DIR);
}
fs.mkdirSync(DEMO_DIR, { recursive: true });

if (!fs.existsSync(path.join(SAMPLE_DIR, 'package.json'))) {
  fail('sample project not found at ' + SAMPLE_DIR);
}

const core = require(path.join(REPO_ROOT, 'src', 'core'));
const { StopCode, Planner, PlannerConflict, apiConfiguration, time: T } = core;

// ---------- 2. optional seed through the real core ----------

function seed() {
  const sc = new StopCode();
  const lines = [];

  // The sample lives inside the StopCode repository's Git tree, so automatic root
  // detection would register the repository itself. detect:false pins the demo project to
  // the sample directory, which is what a real user with a separate repository would get.
  const existing = sc.resolveProject(SAMPLE_DIR);
  if (existing && pathKey(existing.root) !== pathKey(SAMPLE_DIR)) {
    lines.push('Warning: a project already covers the sample directory (' + existing.name + ' at ' + existing.root + '); the mission is attached to it. Run with --reset --seed for a clean baseline.');
  }
  const state = sc.readState();
  const activeMission = existing && existing.activeMissionId ? state.missions[existing.activeMissionId] : null;
  if (activeMission && activeMission.status === 'active' && activeMission.objective === MISSION) {
    lines.push('Mission already seeded: "' + MISSION + '" (' + activeMission.id + ')');
  } else {
    const res = sc.startMission({ project: SAMPLE_DIR, objective: MISSION, criteria: CRITERIA, source: 'demo-seed', detect: false });
    lines.push('Mission seeded for ' + res.project.name + ': "' + res.mission.objective + '"');
    res.mission.criteria.forEach((c, i) => lines.push('  ' + (i + 1) + '. ' + c.text + ' (' + c.id + ')'));
    if (res.previousMission) lines.push('  Previous mission preserved in history: "' + res.previousMission.objective + '"');
  }

  // Recovery block tomorrow 18:30-19:00 in the configured timezone, via the Planner.
  const tz = sc.settings().timezone;
  const now = sc.now();
  const tomorrow = T.addLocalDays(now, tz, 1);
  const start = T.zonedToUtc({ year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: 18, minute: 30 }, tz);
  const end = T.zonedToUtc({ year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: 19, minute: 0 }, tz);
  const planner = new Planner(sc);
  const already = planner.list({ from: start, to: end }).find((e) => e.title === RECOVERY_TITLE && e.start === start);
  if (already) {
    lines.push('Recovery block already seeded: ' + RECOVERY_TITLE + ' ' + T.formatDateTime(start, tz) + ' (' + already.id + ')');
  } else {
    try {
      const res = planner.create({ title: RECOVERY_TITLE, type: 'recovery', start, end, notes: 'Seeded by scripts/demo.js --seed. Edit or delete it in the Planner tab.' });
      lines.push('Recovery block seeded: ' + RECOVERY_TITLE + ' ' + T.formatDateTime(start, tz) + '-' + T.formatTime(end, tz) + ' ' + tz + ' (' + res.event.id + ')');
    } catch (e) {
      if (e instanceof PlannerConflict) {
        lines.push('Recovery block NOT seeded: it would overlap ' + e.overlaps.map((o) => '"' + o.title + '"').join(', ') + '. Add one in the Planner tab instead.');
      } else throw e;
    }
  }
  return lines;
}

// ---------- 3. the eight steps ----------

function launchLines() {
  return {
    bash: 'cd "' + fwd(SAMPLE_DIR) + '" && STOPCODE_DATA_DIR="' + fwd(DEMO_DIR) + '" claude --plugin-dir "' + fwd(REPO_ROOT) + '"',
    powershell: '$env:STOPCODE_DATA_DIR = ' + psq(DEMO_DIR) + '; Set-Location ' + psq(SAMPLE_DIR) + '; claude --plugin-dir ' + psq(REPO_ROOT),
  };
}

function steps(cli, port) {
  const url = 'http://127.0.0.1:' + port;
  const launch = launchLines();
  // CLI commands for a separate terminal. --data-dir and --project make them independent of
  // the shell's environment and current directory.
  const c = (args) => cli + ' --data-dir "' + fwd(DEMO_DIR) + '" --project "' + fwd(SAMPLE_DIR) + '" ' + args;
  return [
    {
      title: 'Start a tracked mission in Claude Code and watch real activity',
      lines: [
        'Terminal A (Git Bash):',
        '  ' + launch.bash,
        'Terminal A (Windows PowerShell):',
        '  ' + launch.powershell,
        'In Claude Code:',
        '  /stopcode:start ' + MISSION,
        'Dashboard: ' + url + ' -> Today tab. Every number comes from hook events; "No activity observed yet" until the first one.',
        '(If you seeded, this replaces the seeded mission and keeps it in history; /stopcode:status shows the seeded one unchanged instead.)',
      ],
    },
    {
      title: 'Fix the empty-password bug and capture real test evidence',
      lines: [
        'In Claude Code:',
        '  Run npm test, then fix the empty-password bug in src/auth.js and run npm test again.',
        'The PostToolUse hooks record a test_run evidence entry per run (the failing run first, then the passing run).',
        'Verify criterion 1 explicitly (Terminal C), or ask Claude to do it via /stopcode:status:',
        '  ' + c('evidence add --kind test_run --outcome pass --summary "npm test in sample-project: 4 passed, 0 failed" --criterion 1'),
        '  ' + c('status'),
      ],
    },
    {
      title: 'Park an optional idea, then talk to the wellness chat',
      lines: [
        'Dashboard -> Today -> "Park this idea": Add a password strength meter   (CLI alternative below)',
        '  ' + c('idea add "Add a password strength meter"'),
        'Dashboard -> Chat: "Help me stop for today."',
        'Without ANTHROPIC_API_KEY the chat shows its configuration-required state. Say so; do not fake a reply.',
      ],
    },
    {
      title: 'Plan a recovery block and export it',
      lines: [
        'Dashboard -> Planner -> add a recovery block (e.g. tomorrow 18:30-19:00) -> Export .ics',
        'CLI alternative:',
        '  ' + c('planner add --title "Walk" --type recovery --start <ISO start> --end <ISO end>'),
        '  ' + c('planner ics --out demo-planner.ics'),
      ],
    },
    {
      title: 'Clock out for a short, clearly labelled real interval',
      lines: [
        'Dashboard -> Today -> Clock out -> quiet hours: 2 minutes, "Block new coding actions" checked -> confirm -> open the saved handoff.',
        'CLI alternative:',
        '  ' + c('finish --quiet 2m --protect --note "demo clock-out"'),
        '  ' + c('handoff show'),
      ],
    },
    {
      title: 'Show the boundary holding',
      lines: [
        'In Claude Code (Terminal A), within the 2 minutes:',
        '  Add a password strength meter to src/auth.js',
        'The UserPromptSubmit hook blocks the prompt (PreToolUse denies any tool call that still slips through).',
        'Terminal C: the file is unchanged compared with before the clock-out:',
        '  git -C "' + fwd(REPO_ROOT) + '" status --short -- sample-project',
      ],
    },
    {
      title: 'The wellness chat still works while coding is blocked',
      lines: [
        'Dashboard -> Chat: "What can I do with the next 10 minutes?"',
        'With an API key: a reply and optional suggestion buttons (nothing happens until clicked).',
        'Without one: the same honest configuration-required state as in step 3.',
      ],
    },
    {
      title: 'Resume on purpose',
      lines: [
        'In Claude Code:',
        '  /stopcode:resume',
        'It reports the active boundary and asks for an explicit yes before overriding; then it restores the handoff and stops. No work starts.',
        'CLI alternative (exit code 3 = blocked, then the explicit override):',
        '  ' + c('resume'),
        '  ' + c('resume --override'),
      ],
    },
  ];
}

// ---------- 4. run ----------

function main() {
  const port = Number.isFinite(flags.port) && flags.port > 0 ? flags.port : DEFAULT_PORT;
  const cli = 'node "' + fwd(path.join(REPO_ROOT, 'bin', 'stopcode.js')) + '"';

  out('StopCode demo');
  out('='.repeat(72));
  out('Demo data directory : ' + DEMO_DIR);
  out('Real data directory : ' + realDataDir + ' (not touched)');
  out('Sample project      : ' + SAMPLE_DIR);
  out('Plugin root         : ' + REPO_ROOT);

  out();
  if (flags.seed) {
    out('Seed (through the real core):');
    for (const l of seed()) out('  ' + l);
  } else {
    out('No seed requested (add --seed for a baseline mission and a recovery block).');
  }

  const api = apiConfiguration();
  out();
  out('Wellness chat API   : ' + (api.configured
    ? 'configured via ' + api.source + ' (configured is not the same as tested; use "Test connection" in Settings)'
    : 'not configured (set ANTHROPIC_API_KEY or create .env; the chat shows its configuration-required state)'));

  const launch = launchLines();
  out();
  out('Claude Code launch line for the sample project');
  out('-'.repeat(72));
  out('Git Bash:');
  out('  ' + launch.bash);
  out('Windows PowerShell:');
  out('  ' + launch.powershell);

  out();
  out('The eight demo steps (full narration: docs/DEMO.md)');
  out('-'.repeat(72));
  steps(cli, port).forEach((s, i) => {
    out((i + 1) + '. ' + s.title);
    for (const l of s.lines) out('   ' + l);
    out();
  });
  out('Reset the demo: npm run demo -- --reset        (add --seed to re-create the baseline)');
  out();

  if (flags['no-serve']) {
    out('Dashboard not started (--no-serve). Start it later with:');
    out('  ' + cli + ' --data-dir "' + fwd(DEMO_DIR) + '" serve --port ' + port);
    return;
  }

  let startServer;
  try {
    ({ startServer } = require(path.join(REPO_ROOT, 'src', 'server', 'server.js')));
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /server[\\/]server\.js/.test(String(e.message))) {
      out('Dashboard NOT started: src/server/server.js is missing from this checkout. The demo data directory is ready;');
      out('start the dashboard once the server module exists: ' + cli + ' --data-dir "' + fwd(DEMO_DIR) + '" serve --port ' + port);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (typeof startServer !== 'function') {
    out('Dashboard NOT started: src/server/server.js does not export startServer.');
    process.exitCode = 1;
    return;
  }
  Promise.resolve(startServer({ port, open: !flags['no-open'] }))
    .then((info) => {
      const url = (info && info.url) || 'http://127.0.0.1:' + port;
      out('Dashboard: ' + url + '  (data: ' + DEMO_DIR + ')');
      out('Press Ctrl+C to stop. Quiet hours and handoffs keep working without the dashboard; only the UI goes away.');
    })
    .catch((e) => {
      if (e && e.code === 'EADDRINUSE') fail('port ' + port + ' is already in use; pass --port <other> or stop the other StopCode instance', 1);
      fail('dashboard failed to start: ' + ((e && e.message) || e), 1);
    });
}

main();
