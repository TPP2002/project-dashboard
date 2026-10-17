'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { FramedStream, bounded, failure } = require('../transport/framed.cjs');
const { protectedDirectory } = require('./cloud-hub.cjs');

/** Fixed forced-command entry. Only the configured socket selects a principal; no frame can do so. */
async function runCloudStdio(config, input = process.stdin, output = process.stdout) {
  protectedDirectory(path.dirname(config.socketPath));
  const stat = fs.lstatSync(config.socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('SOCKET_UNPROTECTED');
  const socket = net.createConnection(config.socketPath);
  await bounded(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }),
    { timeoutMs: config.timeoutMs }, () => socket.destroy());
  const remote = new FramedStream(input, output, { timeoutMs: config.timeoutMs });
  const local = new FramedStream(socket, socket, { timeoutMs: config.timeoutMs, expectGreeting: true });
  local.on('greeting', value => remote.sendGreeting(value).catch(error => local.close(error)));
  remote.on('frame', frame => local.send(frame).catch(error => remote.close(error)));
  local.on('frame', frame => remote.send(frame).catch(error => local.close(error)));
  remote.on('closed', error => local.close(error));
  local.on('closed', error => remote.close(error));
  await local.waitGreeting({ timeoutMs: config.timeoutMs });
  return { close() { remote.close(); local.close(); } };
}
if (require.main === module) {
  (async () => {
    if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw failure('FIXED_CONFIG_REQUIRED');
    const file = process.argv[2]; protectedDirectory(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('CONFIG_UNPROTECTED');
    const proxy = await runCloudStdio(JSON.parse(fs.readFileSync(file, 'utf8')));
    process.once('SIGTERM', () => proxy.close()); process.once('SIGINT', () => proxy.close());
  })().catch(error => { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; });
}
module.exports = { runCloudStdio };
