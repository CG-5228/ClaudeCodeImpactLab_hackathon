'use strict';
const crypto = require('crypto');

function randomId(prefix, bytes = 6) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

function stableId(prefix, input, len = 12) {
  return `${prefix}_${crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len)}`;
}

function shortHash(input, len = 8) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

module.exports = { randomId, stableId, shortHash };
