'use strict';
// Entry point for `node --test tests/`.
//
// Node 21+ no longer expands a directory argument into test files: it loads the path as a
// module, which resolves to this file. Grouping every *.test.js file here keeps that command
// working with a single, honest summary line. `node --test` with no arguments (and
// `node --test tests/<file>.test.js`) still runs the same files individually.
const fs = require('fs');
const path = require('path');
const { describe } = require('node:test');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const file of files) {
  describe(file, () => {
    require(path.join(__dirname, file));
  });
}
