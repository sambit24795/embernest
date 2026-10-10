#!/usr/bin/env node
'use strict';
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Embernest needs Node.js 22 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
require('../src/cli/index.js').main(process.argv).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
