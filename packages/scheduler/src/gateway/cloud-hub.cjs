'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const p = require('../protocol/contract.cjs');
const { FramedStream, EnvelopeLink, validateGreeting, failure, bounded } = require('../transport/framed.cjs');

function protectedDirectory(directory) {
  if (process.platform === 'win32') throw failure('UNIX_SOCKET_REQUIRED');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('SOCKET_DIRECTORY_UNPROTECTED');
}
function createCloudHub({ getAuthority, config }) {
  // The composition root supplies the live authority health after its durable epoch allocation.
  // Freeze this startup scope; an edited file cannot silently change an existing hub's identity.
  const greeting = Object.freeze(validateGreeting({ transport: 'scheduler-gateway-hello.v1',
    authorityId: config.authorityId, authorityEpoch: config.authorityEpoch }));
  const links = new Map(), sockets = new Set(), servers = new Map();
  let closed = false;
  async function listen(socketPath) {
    if (closed || servers.has(socketPath)) throw failure('ALREADY_STARTED');
    const entry = config.entries.find(item => item.socketPath === socketPath);
    if (!entry || !entry.principal || !path.isAbsolute(socketPath)) throw failure('NOT_CONFIGURED');
    protectedDirectory(path.dirname(socketPath));
    // Never unlink an existing socket: it may belong to the current sole authority.
    if (fs.existsSync(socketPath)) throw failure('SOCKET_IN_USE');
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      const principal = structuredClone(entry.principal); // from protected deployment, never from the frame
      let nodeId = null, session = null, sequence = 0, opening = false;
      const stream = new FramedStream(socket, socket, { timeoutMs: config.timeoutMs });
      stream.sendGreeting(greeting)
        .catch(error => stream.close(error));
      const link = new EnvelopeLink(stream, {
        authenticate(envelope) {
          if (nodeId !== null && envelope.nodeId !== nodeId) throw failure('NODE_CHANGED');
          if (session === null) {
            if (opening || envelope.kind !== 'session.open') throw failure('HANDSHAKE_REQUIRED');
            // The authority validates persisted replacement/generation. Hub is not a second session writer.
            p.validateEnvelope(envelope, { principal, localRole: 'cloud', authorityId: greeting.authorityId,
              authorityEpoch: greeting.authorityEpoch, allowedNodes: principal.nodeIds,
              activeSession: envelope.payload.replacesSession, lastSequence: 0 });
            opening = true; nodeId = envelope.nodeId;
            return true;
          }
          const validated = p.validateEnvelope(envelope, { principal, localRole: 'cloud', authorityId: greeting.authorityId,
            authorityEpoch: greeting.authorityEpoch, allowedNodes: principal.nodeIds, activeSession: session, lastSequence: sequence });
          if (!validated.transport.updatesLastSeen) return false;
          sequence = envelope.sequence; return true;
        },
        requestKinds: p.KINDS.filter(kind => p.ROUTES[kind].some(([from, to]) => from === 'windows' && to === 'cloud')),
        async onRequest(envelope) {
          const authority = getAuthority();
          if (!authority) throw failure('NOT_CONFIGURED');
          const reply = await authority.accept(principal, envelope, { timeoutMs: config.timeoutMs });
          p.validateResponse(envelope, reply);
          if (envelope.kind === 'session.open' && reply.kind === 'result' && reply.payload.status === 'business_accepted' && reply.payload.outcome.kind === 'applied') {
            const previous = links.get(envelope.nodeId);
            if (previous && previous !== link) previous.close();
            nodeId = envelope.nodeId; session = envelope.nodeSession; sequence = envelope.sequence;
            links.set(nodeId, link);
          }
          return reply;
        },
      });
      link.on('closed', () => { if (links.get(nodeId) === link) links.delete(nodeId); });
    });
    servers.set(socketPath, server);
    try {
      await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }), { timeoutMs: config.timeoutMs });
      fs.chmodSync(socketPath, 0o600);
    } catch (error) { servers.delete(socketPath); server.close(); throw error; }
  }
  return {
    listen,
    sendToNode(nodeId, request, options) {
      if (request.nodeId !== nodeId) return Promise.reject(failure('NODE_MISMATCH'));
      const link = links.get(nodeId);
      return link ? link.exchange(request, options) : Promise.reject(failure('DISCONNECTED'));
    },
    async close() {
      if (closed) return; closed = true;
      for (const link of links.values()) link.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([...servers.values()].map(server => new Promise(resolve => server.close(resolve))));
      servers.clear(); links.clear();
    },
  };
}
module.exports = { createCloudHub, protectedDirectory };
