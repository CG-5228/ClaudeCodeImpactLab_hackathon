'use strict';
// Child process used by tests/core.store.test.js to hammer one data directory from several
// processes at once. Not a test file: it exits immediately when started without arguments.
//
//   node concurrency-worker.js <dataDir> <projectDir> <tools|breaks> <workerId> <count>
const path = require('path');

const [dataDir, projectDir, mode, workerId, countArg] = process.argv.slice(2);
if (!dataDir || !projectDir || !mode) process.exit(0);

const { StopCode } = require(path.join(__dirname, '..', '..', 'src', 'core'));

const sc = new StopCode({ dataDir });
const count = Number(countArg) || 0;
let lockTimeouts = 0;

// The store raises LockTimeoutError after waiting 8 s for the cross-process lock. A real
// caller would surface that; here we retry so the assertion stays "nothing was lost".
function attempt(fn) {
  for (let i = 0; i < 10; i++) {
    try {
      return fn();
    } catch (e) {
      if (e && e.name === 'LockTimeoutError') {
        lockTimeouts++;
        continue;
      }
      throw e;
    }
  }
  throw new Error(`worker ${workerId}: gave up after repeated lock timeouts`);
}

const done = [];
try {
  if (mode === 'tools') {
    for (let i = 0; i < count; i++) {
      const toolUseId = `w${workerId}-${i}`;
      const isEdit = i % 3 === 0;
      attempt(() =>
        sc.recordToolEvent({
          sessionId: `sess-${workerId}`,
          toolUseId,
          toolName: isEdit ? 'Edit' : 'Bash',
          toolInput: isEdit ? { file_path: path.join(projectDir, 'src', `file-${workerId}.js`) } : { command: `echo step ${i}` },
          toolResponse: { stdout: 'ok', stderr: '' },
          ok: true,
          cwd: projectDir,
        })
      );
      done.push(toolUseId);
    }
  } else if (mode === 'breaks') {
    for (let i = 0; i < count; i++) {
      attempt(() => sc.startBreak({ note: `worker ${workerId} break ${i}` }));
      attempt(() => sc.endBreak());
      done.push(`break-${i}`);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, workerId, mode, done: done.length, lockTimeouts }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, workerId, mode, done: done.length, lockTimeouts, error: String((e && e.stack) || e) }));
  process.exitCode = 1;
}
