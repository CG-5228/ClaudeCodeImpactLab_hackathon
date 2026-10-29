'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLogin } = require('../src/auth');

test('valid credentials are accepted', () => {
  const result = validateLogin({ email: 'dev@example.com', password: 'correct horse battery' });
  assert.equal(result.ok, true);
  assert.equal(result.user.email, 'dev@example.com');
});

test('a malformed email is rejected with code invalid_email', () => {
  const result = validateLogin({ email: 'not-an-email', password: 'correct horse battery' });
  assert.deepEqual(result, { ok: false, code: 'invalid_email' });
});

// This test FAILS until the deliberate bug in src/auth.js is fixed (see README.md).
test('an empty password is rejected with code empty_password', () => {
  const result = validateLogin({ email: 'dev@example.com', password: '' });
  assert.deepEqual(result, { ok: false, code: 'empty_password' });
});

test('a short password (fewer than 8 characters) is rejected with code short_password', () => {
  const result = validateLogin({ email: 'dev@example.com', password: 'short' });
  assert.deepEqual(result, { ok: false, code: 'short_password' });
});
