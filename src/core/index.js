'use strict';
const domain = require('./domain');
const planner = require('./planner');
const ics = require('./ics');
const hooks = require('./hooks');
const doctor = require('./doctor');
const time = require('./time');
const paths = require('./paths');
const validate = require('./validate');
const store = require('./store');
const projects = require('./projects');
const redact = require('./redact');

module.exports = {
  ...domain,
  ...planner,
  ...ics,
  ...hooks,
  ...doctor,
  time,
  paths,
  validate,
  store,
  projects,
  redact,
};
