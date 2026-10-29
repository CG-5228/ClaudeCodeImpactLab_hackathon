'use strict';
// Login validation for the StopCode demo project.
//
// This module has ONE deliberate bug: an empty password is accepted. The short-password
// check below is guarded with `password &&`, which was meant to skip non-strings but
// also skips the empty string, so '' sails through and the call returns { ok: true }.
// README.md describes the one-line fix; test/auth.test.js fails 1 of 4 until it is applied.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a login attempt.
 * @param {{email?: unknown, password?: unknown}} credentials
 * @returns {{ok: true, user: {email: string}} | {ok: false, code: string}}
 */
function validateLogin({ email, password } = {}) {
  if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
    return { ok: false, code: 'invalid_email' };
  }
  if (typeof password !== 'string') {
    return { ok: false, code: 'invalid_password' };
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: 'short_password' };
  }
  return { ok: true, user: { email: email.trim().toLowerCase() } };
}

module.exports = { validateLogin, MIN_PASSWORD_LENGTH };
