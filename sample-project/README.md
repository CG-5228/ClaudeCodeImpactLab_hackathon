# stopcode-sample-login

A deliberately tiny Node project (no dependencies) used for the StopCode live demo
(see `../docs/DEMO.md`). It exists so the demo's "fix a small issue and capture real test
evidence" step is reproducible: `npm test` fails 1 of 4 before the fix and passes 4 of 4 after.

## The bug

`src/auth.js` exports `validateLogin({ email, password })`. It rejects malformed emails
(`invalid_email`), non-string passwords (`invalid_password`) and passwords shorter than 8
characters (`short_password`), but it **accepts an empty password**. The short-password check
is guarded with `password &&`, which skips the empty string, so `''` returns `{ ok: true }`.

```
$ npm test
...
# tests 4
# pass 3
# fail 1
```

The failing test is `an empty password is rejected with code empty_password`.

## The one-line fix

Insert this line in `src/auth.js` right after the `typeof password !== 'string'` check and
before the short-password check:

```js
if (password.length === 0) return { ok: false, code: 'empty_password' };
```

Then:

```
$ npm test
...
# tests 4
# pass 4
# fail 0
```

## Restoring the bug (to run the demo again)

Delete the line you added (or `git checkout -- sample-project/src/auth.js` from the StopCode
repository root) and `npm test` fails 1 of 4 again.

## Requirements

Node 22 or newer (uses the built-in `node:test` runner). Run `npm test` from this directory.
