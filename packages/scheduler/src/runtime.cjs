'use strict';
const fs = require('node:fs');
const path = require('node:path');
const deployment = require('./sched/client/deployment-config.cjs');

function readRuntimeConfig(file) {
  if (!path.isAbsolute(file)) throw new Error('Runtime configuration must have an absolute path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
    throw new Error('Runtime configuration must be a protected file owned by the service account');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || value.version !== 1) throw new Error('Unsupported runtime configuration version');
  return value;
}

async function startCloudRuntime(config) {
  if (process.platform === 'win32') throw new Error('The cloud authority requires a Linux host');
  if (!path.isAbsolute(config.dataRoot || '') || !config.catalog || !config.authority || !config.transport) {
    throw new Error('Cloud runtime requires explicit dataRoot, catalog, authority and transport');
  }
  const catalog = deployment.configureDeployment(config.catalog);
  const { createCloudHub } = require('./gateway/cloud-hub.cjs');
  const { createCloudService } = require('./cloud/service.cjs');
  let cloud, hub;
  try {
    cloud = await createCloudService({ dataRoot: config.dataRoot, catalog,
      authority: config.authority, sendToNode: (nodeId, request, options) => {
        if (!hub) return Promise.reject(Object.assign(new Error('Cloud transport is not ready'), { code: 'DISCONNECTED' }));
        return hub.sendToNode(nodeId, request, options);
      } });
    const health = cloud.health();
    if (health.authorityId !== config.authority.id || !Number.isSafeInteger(health.authorityEpoch) || health.authorityEpoch < 1) {
      throw new Error('Cloud service did not expose its committed authority epoch');
    }
    // The service advances this durable generation at startup. Never use a
    // stale value copied into a deployment file for the transport handshake.
    const transport = { ...config.transport, authorityId: health.authorityId, authorityEpoch: health.authorityEpoch };
    if (!Array.isArray(transport.entries) || !transport.entries.length) throw new Error('At least one protected transport entry is required');
    // Hub construction seals its greeting immediately, after the durable epoch
    // exists. Mutating a configuration object afterward cannot update it.
    hub = createCloudHub({ getAuthority: () => cloud.authority, config: transport });
    for (const entry of transport.entries) {
      if (!path.isAbsolute(entry.socketPath || '')) throw new Error('Transport sockets require absolute paths');
      fs.mkdirSync(path.dirname(entry.socketPath), { recursive: true, mode: 0o700 });
      await hub.listen(entry.socketPath);
    }
    await cloud.start();
  } catch (error) {
    if (hub) await hub.close();
    if (cloud) await cloud.close();
    throw error;
  }
  let closed = false;
  return { health: () => cloud.health(), async close() {
    if (closed) return;
    closed = true;
    await hub.close();
    await cloud.close();
  } };
}

async function startNodeRuntime(config) {
  if (process.platform !== 'win32') throw new Error('The execution node requires Windows');
  if (!config.catalog || !config.gateway || !config.node) throw new Error('Node runtime requires catalog, gateway and node configuration');
  deployment.configureDeployment(config.catalog);
  const { createWindowsGateway } = require('./gateway/windows.cjs');
  const { createWindowsNode } = require('./node/runtime.cjs');
  let node;
  const gateway = createWindowsGateway({ config: config.gateway,
    onCloudRequest: (request, options) => node.handleCloudRequest(request, options),
    onLocalExecution: (peer, request, options) => node.handleLocalExecution(peer, request, options) });
  try {
    node = createWindowsNode({ config: config.node, gateway });
    await gateway.start();
    await node.start();
  } catch (error) {
    if (node) await node.close();
    await gateway.close();
    throw error;
  }
  let closed = false;
  return { health: () => ({ gateway: gateway.health(), node: node.health() }), async close() {
    if (closed) return;
    closed = true;
    try { await node.close(); } finally { await gateway.close(); }
  } };
}
module.exports = { readRuntimeConfig, startCloudRuntime, startNodeRuntime };
