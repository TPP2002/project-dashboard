'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { peer } = require('../../core/ownerNodeTransport.cjs');
const { loadConfig } = require('../../core/ownerNodeConfig.cjs');
// Each forced SSH entry has its own protected socket: payloads cannot choose identity.
async function serve(config) {
  const servers = [], peers = new Set();
  try {
    for (const node of config.nodes) {
      let connected;
      for (const [file, accept] of [[node.nodeSocket, socket => {
        connected?.close();
        const current = peer(socket, socket, { initiate: true, onClose: () => { peers.delete(current); if (connected === current) connected = null; } });
        connected = current; peers.add(current);
      }], [node.clientSocket, socket => {
        const client = peer(socket, socket, { initiate: true, handler: request => {
          const project = request.args.projectId || request.args.object?.projectId;
          if (project && !node.projects.includes(project)) throw new Error('Project ownership mismatch');
          if (!connected) throw new Error('Node offline');
          return connected.call(request.operation, request.args, request.operationId ? { operationId: request.operationId, hash: request.hash } : {});
        }, onClose: () => peers.delete(client) }); peers.add(client);
      }]]) {
        if (process.platform !== 'win32') {
          const st = fs.statSync(path.dirname(file));
          if (st.mode & 0o027) throw new Error('Socket directory must deny other users and group writes');
        }
        // Never unlink an existing socket: that can steal a live single writer's address.
        const server = net.createServer(accept);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
        servers.push(server);
      }
    }
  } catch (error) { for (const p of peers) p.close(); for (const s of servers) s.close(); throw error; }
  return { close: async () => { for (const p of peers) p.close(); await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); } };
}
if (require.main === module) serve(loadConfig(process.argv[2], 'cloud')).then(service => {
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { service.close().then(() => process.exit(0)); });
}).catch(() => { process.stderr.write('Owner bridge startup failed; inspect protected configuration/socket ownership\n'); process.exitCode = 1; });
module.exports = { serve };
