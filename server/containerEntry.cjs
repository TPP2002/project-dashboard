'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The optional owner transport uses this container's private ephemeral sockets.
// A container restart removes abandoned sockets while persistent operation
// journals remain in DASHBOARD_HOME for reconciliation.
async function start() {
  let hub, app, closing;
  async function close() {
    if (!closing) closing = (async () => {
      try { if (app) await app.shutdown(); }
      finally { if (hub) await hub.close(); }
    })();
    return closing;
  }
  try {
    if (process.env.DASHBOARD_OWNER_NODE_CONFIG) {
      if (process.env.DASHBOARD_MODE !== 'collaboration') throw new Error('Owner transport requires collaboration mode');
      const config = require('../core/ownerNodeConfig.cjs').loadConfig(process.env.DASHBOARD_OWNER_NODE_CONFIG, 'cloud');
      const root = '/tmp/owner-node';
      for (const node of config.nodes) for (const socket of [node.nodeSocket, node.clientSocket]) {
        const relative = path.relative(root, socket);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          throw new Error('Container owner sockets must be inside /tmp/owner-node');
        }
      }
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const node of config.nodes) for (const socket of [node.nodeSocket, node.clientSocket]) {
        fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
      }
      hub = await require('../packages/owner-node/gateway.cjs').serve(config);
    }
    app = require('./server.cjs');
    if (typeof app.shutdown !== 'function') throw new Error('Server shutdown integration is missing');
    await app.main();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void close().catch(error => { console.error('Container shutdown failed:', error.message); process.exitCode = 1; });
    });
    return { close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the original startup error. */ }
    throw error;
  }
}
if (require.main === module) start().catch(error => {
  console.error('Container startup failed:', error.message); process.exitCode = 1;
});
module.exports = { start };
