'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./ownerNodeContract.cjs');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.startsWith('\\\\') && !value.includes('\0');
const socketAddress = value => absolute(value) || (process.platform === 'win32' && typeof value === 'string' && /^\\\\\.\\pipe\\owner-[A-Za-z0-9-]+$/.test(value));
function loadConfig(file, kind) {
  if (!absolute(file)) throw new Error('Absolute protected config required');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o022) || ![0,process.geteuid()].includes(stat.uid)))) throw new Error('Configuration must be administrator protected');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (kind === 'node') {
    C.fields(config, { version: v => v === C.VERSION, nodeId: C.id, stateRoot: absolute, sessionsRoot: absolute, claudeProjectsRoot: absolute, balance: v => ['windows-key','disabled'].includes(v), projects: v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length>0 }, { ssh: v => !!v, launcher: absolute, schedulerConfig: absolute, dashboardRemoteConfig: absolute });
    for (const [id, project] of Object.entries(config.projects)) {
      if (!C.id(id)) throw new Error('Invalid project');
      C.fields(project, { codeRepo: absolute, docsRoot: absolute, name: v => typeof v === 'string' && v.length <= 128, costRoots: v => Array.isArray(v) && v.length <= 16 && v.every(absolute) }, { githubRepo: v => typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v) });
    }
    if (config.ssh) C.fields(config.ssh, { executable: absolute, host: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}$/.test(v), knownHosts: absolute, identityFile: absolute });
  } else {
    C.fields(config, { version: v => v === C.VERSION, nodes: v => Array.isArray(v) && v.length > 0 && v.length <= 32 }, { stateRoot: absolute });
    const seen = new Set(), projects = new Set();
    for (const node of config.nodes) {
      C.fields(node, { nodeId: C.id, nodeSocket: socketAddress, clientSocket: socketAddress, projects: v => Array.isArray(v) && v.every(C.id) });
      for (const name of [node.nodeId, node.nodeSocket, node.clientSocket]) { if (seen.has(name)) throw new Error('Duplicate node/socket'); seen.add(name); }
      for (const id of node.projects) { if (projects.has(id)) throw new Error('Ambiguous project ownership'); projects.add(id); }
    }
  }
  return config;
}
module.exports = { loadConfig, absolute };
