'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEMO_MARKER_FILE = 'demo-instance.json';

function findDemoDir({ registryPath, home }) {
  for (const dir of [registryPath && path.dirname(registryPath), home]) {
    if (!dir) continue;
    try {
      fs.statSync(path.join(dir, DEMO_MARKER_FILE));
      return dir;
    } catch (_) { /* No accessible marker in this directory. */ }
  }
  return null;
}

module.exports = { DEMO_MARKER_FILE, findDemoDir };
