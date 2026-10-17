'use strict';
// Installed builds resolve package-local .js. Source runs require the repository's
// TypeScript loader; no private checkout, runtime compiler or npm dependency here.
const fs = require('node:fs');
const path = require('node:path');
module.exports = name => {
  if (!/^[a-z-]+$/.test(name)) throw new Error('invalid domain module');
  const base = path.join(__dirname, '..', 'sched', name);
  return require(fs.existsSync(`${base}.js`) ? `${base}.js` : `${base}.ts`);
};
