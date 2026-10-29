'use strict';
// Durable local-first storage: a cross-process lock, atomic JSON writes with backup and
// recovery, a bounded append-only event log per project, and a health file for the
// integration self-check. Everything is synchronous so hooks stay small and fast.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths: buildPaths } = require('./paths');
const { defaultState, migrate } = require('./state');

const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 8000;
const EVENTS_MAX_BYTES = 1.5 * 1024 * 1024;
const EVENTS_KEEP_LINES = 2000;
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 200 * 1024;

class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockTimeoutError';
    this.status = 503;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

function renameWithRetry(from, to) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleepSync(15 + i * 20);
    }
  }
  throw lastErr;
}

class Store {
  constructor(dataDir) {
    this.p = buildPaths(dataDir);
    this.ensured = false;
  }

  get root() {
    return this.p.root;
  }

  ensure() {
    if (this.ensured) return;
    ensureDir(this.p.root);
    ensureDir(this.p.events);
    ensureDir(this.p.handoffs);
    ensureDir(path.dirname(this.p.chat));
    ensureDir(path.dirname(this.p.hookLog));
    this.ensured = true;
  }

  // ---------- locking ----------
  acquireLock() {
    this.ensure();
    const start = Date.now();
    const owner = path.join(this.p.lock, 'owner.json');
    for (;;) {
      try {
        fs.mkdirSync(this.p.lock);
        try {
          fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        } catch (e) {
          /* owner file is informational */
        }
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let stale = false;
        try {
          const st = fs.statSync(this.p.lock);
          stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        } catch (e2) {
          stale = false;
        }
        if (stale) {
          try {
            fs.rmSync(this.p.lock, { recursive: true, force: true });
          } catch (e3) {
            /* another process may have removed it */
          }
          continue;
        }
        if (Date.now() - start > LOCK_WAIT_MS) {
          throw new LockTimeoutError('StopCode data is locked by another process; try again in a moment');
        }
        sleepSync(10 + Math.floor(Math.random() * 30));
      }
    }
  }

  releaseLock() {
    try {
      fs.rmSync(this.p.lock, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  withLock(fn) {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  // ---------- JSON documents ----------
  readJsonRaw(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (e) {
        return { ok: false, error: e, code: 'EPARSE' };
      }
    } catch (e) {
      return { ok: false, error: e, code: e.code || 'EREAD' };
    }
  }

  writeJsonAtomic(file, value, { backup = false } = {}) {
    this.ensure();
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    if (backup) {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
      } catch (e) {
        /* backup is best effort */
      }
    }
    try {
      renameWithRetry(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {
        /* ignore */
      }
      throw e;
    }
  }

  // ---------- state ----------
  // Returns migrated state. Recovers from a corrupt file using the backup; the corrupt
  // copy is preserved for inspection and the incident is recorded in health.json.
  readState() {
    this.ensure();
    const raw = this.readJsonRaw(this.p.state);
    if (raw.ok && raw.value && typeof raw.value === 'object') return migrate(raw.value);
    if (!raw.ok && raw.code === 'ENOENT') return migrate(defaultState());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let recoveredFrom = 'fresh';
    try {
      fs.copyFileSync(this.p.state, `${this.p.state}.corrupt-${stamp}`);
    } catch (e) {
      /* ignore */
    }
    const bak = this.readJsonRaw(this.p.stateBackup);
    let state;
    if (bak.ok && bak.value && typeof bak.value === 'object') {
      state = migrate(bak.value);
      recoveredFrom = 'backup';
    } else {
      state = migrate(defaultState());
    }
    this.updateHealth({
      storage: {
        lastRecovery: {
          at: new Date().toISOString(),
          from: recoveredFrom,
          error: raw.error ? String(raw.error.message || raw.error) : 'unknown',
          preservedCopy: `${this.p.state}.corrupt-${stamp}`,
        },
      },
    });
    try {
      this.writeJsonAtomic(this.p.state, state, { backup: false });
    } catch (e) {
      /* ignore, caller will retry on next write */
    }
    return state;
  }

  writeState(state) {
    state.updatedAt = new Date().toISOString();
    this.writeJsonAtomic(this.p.state, state, { backup: true });
    this.updateHealth({ storage: { lastWriteAt: state.updatedAt, lastError: null } });
  }

  // Read-modify-write under the cross-process lock. `fn` receives the state and returns a
  // result; the state is persisted only if fn did not throw.
  update(fn) {
    return this.withLock(() => {
      const state = this.readState();
      const result = fn(state);
      this.writeState(state);
      return result;
    });
  }

  // ---------- events (append-only, bounded, per project) ----------
  appendEvent(projectId, event) {
    return this.withLock(() => this.appendEventUnlocked(projectId, event));
  }

  // Caller must already hold the lock (used inside `update` so state counters and the
  // event log change together).
  appendEventUnlocked(projectId, event) {
    this.ensure();
    const file = this.p.eventsFile(projectId);
    if (event.id && this.hasRecentEventId(file, event.id)) return { duplicate: true, event };
    // An append interrupted mid-line leaves no trailing newline; starting a fresh line keeps
    // the partial record as the only casualty instead of gluing this event onto it.
    const separator = this.endsWithNewline(file) ? '' : '\n';
    fs.appendFileSync(file, separator + JSON.stringify(event) + '\n');
    if (fileSize(file) > EVENTS_MAX_BYTES) this.compactEvents(file);
    return { duplicate: false, event };
  }

  endsWithNewline(file) {
    const size = fileSize(file);
    if (!size) return true;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  hasRecentEventId(file, id) {
    const size = fileSize(file);
    if (!size) return false;
    const want = Math.min(size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      return buf.toString('utf8').includes(`"id":${JSON.stringify(id)}`);
    } finally {
      fs.closeSync(fd);
    }
  }

  compactEvents(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-EVENTS_KEEP_LINES);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, keep.join('\n') + '\n');
    renameWithRetry(tmp, file);
  }

  // Tolerant reader: skips malformed lines (for example a line cut off by an interrupted
  // write) and reports how many were skipped.
  readEvents(projectId, { limit = 500 } = {}) {
    const file = this.p.eventsFile(projectId);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { events: [], skipped: 0 };
      throw e;
    }
    const events = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.at === 'string') events.push(ev);
        else skipped++;
      } catch (e) {
        skipped++;
      }
    }
    return { events: limit ? events.slice(-limit) : events, skipped };
  }

  deleteEvents(projectId) {
    try {
      fs.unlinkSync(this.p.eventsFile(projectId));
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- health + diagnostics ----------
  readHealth() {
    const raw = this.readJsonRaw(this.p.health);
    return raw.ok && raw.value && typeof raw.value === 'object' ? raw.value : {};
  }

  updateHealth(patch) {
    try {
      const current = this.readHealth();
      for (const [k, v] of Object.entries(patch || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object') {
          current[k] = { ...current[k], ...v };
        } else {
          current[k] = v;
        }
      }
      current.updatedAt = new Date().toISOString();
      this.writeJsonAtomic(this.p.health, current);
    } catch (e) {
      /* health is best effort and must never break callers */
    }
  }

  log(line) {
    try {
      this.ensure();
      fs.appendFileSync(this.p.hookLog, `${new Date().toISOString()} ${line}\n`);
      if (fileSize(this.p.hookLog) > LOG_MAX_BYTES) {
        const text = fs.readFileSync(this.p.hookLog, 'utf8');
        fs.writeFileSync(this.p.hookLog, text.slice(-LOG_KEEP_BYTES));
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- wellness chat (logically separate document) ----------
  readChat() {
    const raw = this.readJsonRaw(this.p.chat);
    if (raw.ok && raw.value && typeof raw.value === 'object') return raw.value;
    return { version: 1, conversations: {} };
  }

  writeChat(doc) {
    this.writeJsonAtomic(this.p.chat, doc, { backup: true });
  }

  // ---------- handoffs ----------
  writeHandoffFile(projectId, fileName, markdown) {
    const dir = this.p.handoffDir(projectId);
    ensureDir(dir);
    const file = path.join(dir, fileName);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, markdown, 'utf8');
    renameWithRetry(tmp, file);
    return file;
  }

  readHandoffFile(file) {
    const resolved = path.resolve(file);
    const base = path.resolve(this.p.handoffs);
    if (!resolved.startsWith(base)) throw new Error('handoff path is outside the data directory');
    return fs.readFileSync(resolved, 'utf8');
  }

  // Writable check used by the self-check. Creates and removes a probe file.
  probeWritable() {
    try {
      this.ensure();
      const probe = path.join(this.p.root, `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
}

module.exports = { Store, LockTimeoutError, sleepSync, ensureDir };
