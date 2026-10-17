'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { FramedStream, failure, timeout } = require('./framed.cjs');

function posixQuote(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw failure('SSH_CONFIG');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function sshArgv(config) {
  if (!config || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.host) ||
      !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(config.user) ||
      !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535 ||
      !path.isAbsolute(config.knownHostsFile) || !path.isAbsolute(config.identityFile) ||
      !Array.isArray(config.entryArgv) || !config.entryArgv.length || !config.entryArgv[0].startsWith('/')) throw failure('SSH_CONFIG');
  timeout({ timeoutMs: config.connectTimeoutMs });
  return ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'RequestTTY=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=${Math.ceil(config.connectTimeoutMs / 1000)}`,
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-i', config.identityFile,
    '-p', String(config.port), '-l', config.user, config.host, config.entryArgv.map(posixQuote).join(' ')];
}
function openSsh(config) {
  if (!path.isAbsolute(config.executable)) throw failure('SSH_EXECUTABLE');
  const child = spawn(config.executable, sshArgv(config), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stream = new FramedStream(child.stdout, child.stdin, { timeoutMs: config.rpcTimeoutMs, expectGreeting: true });
  // SSH diagnostics never enter the framed stdout stream, and are not accumulated.
  child.stderr.on('data', () => {});
  child.on('error', error => stream.close(error));
  child.on('exit', () => stream.close(failure('DISCONNECTED')));
  stream.on('closed', () => { child.stdin.destroy(); child.kill(); });
  return stream;
}
module.exports = { posixQuote, sshArgv, openSsh };
