'use strict';
// Install as an SSH forced command. Config and node ID are literal administrator argv,
// never SSH_ORIGINAL_COMMAND, forwarded environment, or a frame's claimed principal.
const net = require('node:net');
const { loadConfig } = require('../../core/ownerNodeConfig.cjs');
function entry(config, nodeId, input = process.stdin, output = process.stdout) {
  const node = config.nodes.find(n => n.nodeId === nodeId);
  if (!node) throw new Error('Unknown fixed entry');
  const socket = net.connect(node.nodeSocket);
  socket.on('error', () => { process.stderr.write('Owner bridge unavailable\n'); socket.destroy(); process.exitCode = 1; });
  input.pipe(socket); socket.pipe(output); input.on('end', () => socket.end());
  return socket;
}
if (require.main === module) { try { entry(loadConfig(process.argv[2], 'cloud'), process.argv[3]); } catch { process.stderr.write('Invalid fixed entry\n'); process.exitCode = 1; } }
module.exports = { entry };
