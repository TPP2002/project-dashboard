'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../protocol/contract.cjs');
const { EnvelopeLink, failure, timeout, bounded } = require('../transport/framed.cjs');
const { openSsh } = require('../transport/ssh.cjs');
const { createNativeServer, checkPeer } = require('../transport/local-ipc.cjs');
const { GatewayStore } = require('./store.cjs');
const { createRuntimeScope } = require('./runtime.cjs');
const { SerialSender } = require('../transport/sender.cjs');

const CLOUD_REQUESTS = ['origin.request', 'process.stop-request', 'handoff.intent', 'handoff.publish',
  'handoff.observe-request', 'handoff.quarantine', 'snapshot.request', 'artifact.read', 'log.read'];
const NATIVE_KINDS = ['origin.proof', 'process.stop-proof', 'machine.observation', 'report.started', 'report.finished',
  'execution.heartbeat', 'resident.renewal', 'lease.challenge', 'handoff.observe', 'snapshot.metadata', 'launch.notice'];
function createWindowsGateway({ config, onCloudRequest, onLocalExecution }) {
  let store;
  const runtimeState = createRuntimeScope({ nextGeneration: () => store.mutate(state => {
    state.runtimeGeneration = (state.runtimeGeneration ?? 0) + 1; return state.runtimeGeneration;
  }) }), gatewayInstance = randomUUID(), nodeInstance = randomUUID(), clockId = randomUUID();
  let authorityEpoch = config.authorityEpoch;
  let cache, link, ipc, scope, sender, sequence = 0, incomingSequence = 0, started = false, closed = false, starting = false;
  let reconnectTimer, attempts = 0, lastSeen = null, projection = null, projectionAt = null, lastClock = 0;
  const minted = new WeakSet(), activeCloudRequests = new WeakSet(), operations = new Map(), sentReplies = new WeakMap(), responseWrites = new WeakMap(), receivedAt = new WeakMap(), waitingReplies = new WeakMap();
  const notifications = [], receivers = new Set();
  let notificationBytes = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  const options = () => ({ timeoutMs: config.timeoutMs });
  function envelope(kind, payload, identity, messageId = randomUUID()) {
    if (!scope) throw failure('DISCONNECTED');
    if (!Number.isSafeInteger(sequence + 1)) throw failure('SEQUENCE_EXHAUSTED');
    p.validateRequest(kind, payload);
    const value = { protocolVersion: p.PROTOCOL_VERSION, authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch,
      nodeId: scope.nodeId, nodeSession: scope.nodeSession, messageId, sequence: ++sequence, kind, payload,
      ...(identity ? { execution: identity } : {}) };
    value.contentHash = p.envelopeHash(value);
    const sealed = p.decodeFrame(p.encodeFrame(value)); minted.add(sealed); return sealed;
  }
  function authenticate(value) {
    const checked = p.validateEnvelope(value, { principal: config.cloudPrincipal, localRole: 'windows',
      authorityId: config.authorityId, authorityEpoch, allowedNodes: [config.nodeId],
      activeSession: scope.nodeSession, lastSequence: incomingSequence });
    if (!checked.transport.updatesLastSeen) return false;
    incomingSequence = value.sequence; lastSeen = performance.now(); receivedAt.set(value, lastSeen); return true;
  }
  function loseConnection(error) {
    if (!scope && !link) return;
    const previous = link; link = null; scope = null; started = false; projection = null; projectionAt = null;
    sender?.close(); sender = null;
    lastSeen = null; cache?.disconnect(); runtimeState.publish('disconnected', null); previous?.close();
    for (const receiver of receivers) receiver.reject(error); receivers.clear(); notifications.length = 0; notificationBytes = 0;
    if (!closed) scheduleReconnect();
  }
  function scheduleReconnect() {
    if (reconnectTimer || closed) return;
    if (attempts >= config.maxReconnectAttempts) { readyReject(failure('RECONNECT_EXHAUSTED')); return; }
    const delay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** attempts++);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(() => {}); }, delay);
  }
  async function connect() {
    sequence = 0; incomingSequence = 0;
    runtimeState.publish('replacing', null);
    // A test transport must be explicitly injected by a fixture; production always spawns fixed SSH.
    let stream;
    try {
      stream = config.transportFactory ? await config.transportFactory() : openSsh(config.ssh);
      const greeting = await stream.waitGreeting(options());
      const previousEpoch = store.state.highestEpoch ?? config.authorityEpoch;
      const minimumEpoch = Math.max(previousEpoch, config.authorityEpoch);
      if (greeting.authorityId !== config.authorityId || !Number.isSafeInteger(previousEpoch) || previousEpoch < 1 ||
          !Number.isSafeInteger(config.authorityEpoch) || config.authorityEpoch < 1 || greeting.authorityEpoch < minimumEpoch) throw failure('AUTHORITY_GREETING');
      authorityEpoch = greeting.authorityEpoch;
      store.mutate(state => {
        if (authorityEpoch > previousEpoch) { state.session = null; delete state.pendingSession; }
        state.highestEpoch = authorityEpoch;
      });
      cache.authorityEpoch = authorityEpoch;
    } catch (error) { stream?.close(error); runtimeState.publish('disconnected', null); scheduleReconnect(); throw error; }
    const session = store.newSession();
    scope = { authorityId: config.authorityId, authorityEpoch, nodeId: config.nodeId,
      nodeSession: session.nodeSession, gatewayInstance, nodeInstance };
    const current = new EnvelopeLink(stream, { authenticate, requestKinds: CLOUD_REQUESTS,
      async onRequest(request) {
        if (!started || !scope || request.nodeSession !== scope.nodeSession) throw failure('FENCED');
        activeCloudRequests.add(request);
        try {
          let reply;
          if (typeof onCloudRequest === 'function') reply = await bounded(onCloudRequest(request, options()), options());
          else {
            const pending = new Promise(resolve => waitingReplies.set(request, resolve));
            const receiver = receivers.values().next().value;
            if (receiver) { receivers.delete(receiver); receiver.resolve(request); }
            else {
              const bytes = Buffer.byteLength(p.encodeFrame(request));
              if (notifications.length >= 32 || notificationBytes + bytes > p.MAX_FRAME_BYTES) throw failure('BUFFER_PRESSURE');
              notifications.push(request); notificationBytes += bytes;
            }
            reply = await bounded(pending, options());
          }
          if (!minted.has(reply)) throw failure('NODE_REPLY_NOT_MINTED');
          p.validateResponse(request, reply);
          const sent = sentReplies.get(request);
          if (!sent || sent.response !== reply) throw failure('NODE_REPLY_NOT_SENT');
          await sent.promise; return null;
        } finally { activeCloudRequests.delete(request); waitingReplies.delete(request); }
      } });
    link = current; sender = new SerialSender(); current.once('closed', error => { if (link === current) loseConnection(error); });
    try {
      const open = envelope('session.open', { replacesSession: session.replacesSession, sessionGeneration: session.generation }, undefined, session.messageId);
      const ack = await current.exchange(open, options());
      const prior = { ...p.initialProtocolState({ ...config, authorityEpoch }), activeSession: session.replacesSession, sessionGeneration: session.generation - 1,
        businessCursor: store.state.businessCursor ?? { seq: 0, hash: null } };
      const accepted = p.acceptSessionReply(prior, open, ack, { principal: config.cloudPrincipal, localRole: 'windows',
        authorityId: config.authorityId, authorityEpoch, allowedNodes: [config.nodeId] }, receivedAt.get(ack));
      if (!accepted.allowed) throw failure(accepted.reason);
      if (link !== current || closed) throw failure('FENCED');
      store.acknowledgeSession(); store.mutate(state => { state.businessCursor = ack.payload.businessCursor; }); started = true;
      runtimeState.publish('connected', scope); cache.connect(scope.nodeSession); readyResolve();
      // Immutable original operation payload only. No waiting/live/renewal payload is ever replayed.
      for (const operation of store.pending()) {
        if (link !== current) break;
        await request(operation.kind, operation.payload, operation.execution, options());
      }
      attempts = 0;
    } catch (error) { if (link === current) loseConnection(error); throw error; }
  }
  async function exchange(value, callOptions) {
    timeout(callOptions);
    if (!minted.has(value)) throw failure('GATEWAY_ENVELOPE_REQUIRED');
    if (!started || !scope || !link || value.nodeSession !== scope.nodeSession) throw failure('DISCONNECTED');
    const current = link;
    const reply = await sender.enqueue(value, remaining => {
      if (link !== current || !scope || value.nodeSession !== scope.nodeSession) throw failure('FENCED');
      return current.exchange(value, remaining);
    }, callOptions);
    if (link !== current || !scope) throw failure('FENCED');
    if (reply.kind === 'state.snapshot') {
      if (reply.payload.gatewayInstance !== gatewayInstance || reply.payload.nodeInstance !== nodeInstance) throw failure('PROJECTION_SCOPE');
      projection = reply.payload; projectionAt = receivedAt.get(reply);
    }
    return reply;
  }
  async function request(kind, payload, identity, callOptions) {
    if (!started || !scope || !link) throw failure('DISCONNECTED');
    const value = envelope(kind, payload, identity);
    if (!p.IMMUTABLE_KINDS.includes(kind)) return exchange(value, callOptions);
    const operation = store.remember(value), key = operation.identity.operationKey;
    // Even a stored business result is rebound by the authority to this transport envelope.
    // Returning a stale started ACK here could release a child in the wrong connection generation.
    if (operations.has(key)) return operations.get(key);
    const work = exchange(value, callOptions).then(reply => {
      if (reply.kind === 'result') store.settle(value, reply.payload);
      return reply;
    }).finally(() => operations.delete(key));
    operations.set(key, work); return work;
  }
  function ordinary(peer) { return checkPeer(peer, config.ipc.cli.peers); }
  async function trusted(peer, callOptions) {
    if (!ipc) throw failure('DISCONNECTED');
    return ipc.verifyExecution(peer, callOptions);
  }
  function captureSubmissionSource(peer, callId, submissionHash) {
    ordinary(peer);
    if (!/^[a-f0-9]{64}$/.test(submissionHash)) throw failure('SUBMISSION_HASH');
    return store.source(peer, callId, submissionHash);
  }
  function captureResidentIdentity(peer, request) {
    ordinary(peer);
    const ticket = cache.findTicket(request.ticketId, peer);
    const source = store.state.sources[ticket.contentHash];
    if (!source || source.observedOwnerSid !== peer.sid || ticket.request.resident !== true ||
        ticket.currentAttemptId !== request.attemptId) throw failure('RESIDENT_SOURCE');
    return { stage: 'resident', ticketId: request.ticketId, attemptId: request.attemptId, permitToken: request.permitToken,
      renewer: { pid: peer.pid, creationFileTime: peer.creationFileTime }, source };
  }
  const semantic = Object.freeze({
    captureSubmissionSource, captureResidentIdentity,
    async accept(peer, input, callOptions) {
      peer = ordinary(peer); const local = p.validateLocalSemanticRequest(input); timeout(callOptions);
      if (['local-run', 'local-run-read', 'local-run-cancel'].includes(local.kind)) {
        if (closed || !ipc || typeof onLocalExecution !== 'function') throw failure('NOT_CONFIGURED');
        // The ordinary OS peer is an execution intent's caller, never a native fact capability.
        // Reads/cancellation remain reachable on a disconnected uplink; node owns their domain gates.
        return p.validateLocalExecutionReply(await bounded(onLocalExecution(peer, local, callOptions), callOptions));
      }
      if (!started || !scope || !link) throw failure('DISCONNECTED');
      switch (local.kind) {
        case 'submit': {
          store.captureOriginal(peer, local);
          const response = await request('submission', local.request, undefined, callOptions);
          return { kind: 'business', result: response.payload };
        }
        case 'command': {
          const response = await request('command', local.command, undefined, callOptions);
          return { kind: 'business', result: response.payload };
        }
        case 'read': return { kind: 'read', manifest: await cache.read(local, peer, callOptions) };
        case 'read-object': return { kind: 'bytes', callId: local.callId, chunk: cache.chunk(local, peer) };
        case 'resident-renew': {
          const identity = captureResidentIdentity(peer, local);
          const response = await request('resident.renewal', { schema: 1, ticketId: local.ticketId, machine: config.machine,
            cores: local.cores, pid: peer.pid, at: new Date().toISOString() }, identity, callOptions);
          return { kind: 'business', result: response.payload };
        }
        case 'wait': {
          const upsert = store.waiting(local.ticketId, config.machine, false, peer);
          await request('waiting.upsert', upsert, undefined, callOptions);
          const manifest = await cache.read({ kind: 'read', callId: local.callId, selectors: [{ kind: 'ticket', ticketId: local.ticketId }],
            snapshotId: null, pageToken: null }, peer, callOptions);
          const ticket = cache.findTicket(local.ticketId, peer);
          if (ticket.lastSeq > local.afterSeq) {
            const tombstone = store.waiting(local.ticketId, config.machine, true, peer);
            if (scope && link) await request('waiting.delete', tombstone, undefined, callOptions);
            return { kind: 'read', manifest };
          }
          return { kind: 'pending', callId: local.callId, retryAfterMs: 1000 };
        }
      }
    },
  });
  const execution = Object.freeze({
    async prepareObservation(peer, observation, callOptions) {
      timeout(callOptions); peer = await trusted(peer, callOptions);
      if (!started || !scope || !sender || !NATIVE_KINDS.includes(observation.kind) ||
          Object.keys(observation).some(key => !['kind', 'payload', 'identity'].includes(key))) throw failure('NATIVE_KIND');
      if (observation.kind === 'lease.challenge' && (observation.payload.gatewayInstance !== scope.gatewayInstance ||
          observation.payload.nodeInstance !== scope.nodeInstance)) throw failure('LEASE_SCOPE');
      const value = envelope(observation.kind, observation.payload, observation.identity), current = link;
      return sender.prepare(peer, value, async remaining => {
        if (link !== current || !scope || value.nodeSession !== scope.nodeSession) throw failure('FENCED');
        if (p.IMMUTABLE_KINDS.includes(value.kind)) store.remember(value);
        const reply = await current.exchange(value, remaining);
        if (link !== current || !scope) throw failure('FENCED');
        if (p.IMMUTABLE_KINDS.includes(value.kind) && reply.kind === 'result') store.settle(value, reply.payload);
        return reply;
      }, callOptions);
    },
    async sendPrepared(peer, preparationId, callOptions) {
      peer = await trusted(peer, callOptions); if (!scope || !sender) throw failure('DISCONNECTED');
      const result = await sender.sendPrepared(peer, preparationId, callOptions);
      await trusted(peer, callOptions);
      return result;
    },
    async acceptObservation(peer, observation, callOptions) {
      peer = await trusted(peer, callOptions);
      if (!NATIVE_KINDS.includes(observation.kind) || Object.keys(observation).some(key => !['kind', 'payload', 'identity'].includes(key))) throw failure('NATIVE_KIND');
      if (observation.kind === 'lease.challenge') throw failure('PREPARE_REQUIRED');
      const reply = await request(observation.kind, observation.payload, observation.identity, callOptions);
      await trusted(peer, callOptions);
      if (reply.kind !== 'result') throw failure('RESULT_REQUIRED');
      return p.validateResult(reply.payload);
    },
  });
  const port = Object.freeze({
    exchange,
    async send(value, callOptions) { const reply = await exchange(value, callOptions); if (reply.kind !== 'result') throw failure('RESULT_REQUIRED'); return p.validateResult(reply.payload); },
    async receive(callOptions) {
      timeout(callOptions); if (!scope || !link) throw failure('DISCONNECTED');
      if (typeof onCloudRequest === 'function') throw failure('NOT_CONFIGURED');
      if (notifications.length) { const value = notifications.shift(); notificationBytes -= Buffer.byteLength(p.encodeFrame(value)); return value; }
      if (receivers.size >= 32) throw failure('BUFFER_PRESSURE');
      let receiver;
      try { return await bounded(new Promise((resolve, reject) => { receiver = { resolve, reject }; receivers.add(receiver); }), callOptions); }
      finally { receivers.delete(receiver); }
    },
    async respond(response, callOptions) {
      if (!minted.has(response) || !scope || response.nodeSession !== scope.nodeSession) throw failure('FENCED');
      const sent = responseWrites.get(response);
      if (!sent) throw failure('UNKNOWN_REPLY'); await bounded(sent, callOptions);
    },
    readFreshProjection(context) {
      const now = performance.now();
      if (!scope || !projection || projectionAt === null || now < lastClock || now - projectionAt >= config.projectionTtlMs) return { allowed: false, reason: 'PROJECTION_NOT_FRESH' };
      if (!context || Object.keys(scope).some(key => context[key] !== scope[key])) return { allowed: false, reason: 'PROJECTION_SCOPE' };
      lastClock = now;
      return p.evaluateProjection(projection, { ...context, ...scope, clockId, clockDomain: 'node-performance', nowMonotonicMs: now,
        lastMonotonicMs: lastClock, maxAgeMs: config.projectionTtlMs,
        freshness: { ...scope, known: true, clockId, clockDomain: 'node-performance', observedMonotonicMs: projectionAt } });
    },
  });
  return {
    port, semantic, execution, runtime: runtimeState.port,
    submissionSources: Object.freeze({ async get(identity, expectedSource, callOptions) {
      timeout(callOptions);
      if (closed || !store) return { status: 'unknown', reason: 'SOURCE_STORE_UNAVAILABLE' };
      return store.original(identity, expectedSource);
    } }),
    // Private composition capability. No local RPC method returns or registers this identity.
    localExecutionPeer() { if (!ipc) throw failure('DISCONNECTED'); return ipc.localExecutionPeer(); },
    // Fixed in-process reader for the node adapter; no caller-supplied transport identities.
    readProjection(payload, callOptions) { return request('state.read', payload, undefined, callOptions); },
    replyTo(requestEnvelope, kind, payload, identity) {
      if (!activeCloudRequests.has(requestEnvelope)) throw failure('UNKNOWN_REQUEST');
      if (sentReplies.has(requestEnvelope)) throw failure('REPLY_ALREADY_SENT');
      const response = envelope(kind, payload, kind === 'result' ? undefined : (identity ?? requestEnvelope.execution));
      p.validateResponse(requestEnvelope, response);
      if (p.IMMUTABLE_KINDS.includes(kind)) store.remember(response);
      const current = link;
      const promise = sender.enqueue(response, remaining => {
        if (link !== current || !scope || response.nodeSession !== scope.nodeSession) throw failure('FENCED');
        return current.stream.send(response, remaining);
      }, options()); promise.catch(() => {});
      sentReplies.set(requestEnvelope, { response, promise }); responseWrites.set(response, promise);
      waitingReplies.get(requestEnvelope)?.(response); return response;
    },
    async start() {
      if (closed) throw failure('CLOSED'); if (starting || ipc) return bounded(ready, { timeoutMs: config.startupTimeoutMs });
      starting = true;
      try {
      timeout(options());
      if (!Number.isSafeInteger(config.maxReconnectAttempts) || config.maxReconnectAttempts < 1 || config.maxReconnectAttempts > 32 ||
          config.reconnectBaseMs < 1 || config.reconnectMaxMs > 60000 || config.reconnectBaseMs > config.reconnectMaxMs ||
          config.projectionTtlMs < 1 || config.projectionTtlMs > 60000) throw failure('NOT_CONFIGURED');
      ipc = await createNativeServer({ ...config.ipc, protectedPaths: [...new Set([...(config.ipc.protectedPaths ?? []),
        config.stateRoot, config.cache.root, ...(config.ssh ? [config.ssh.identityFile, config.ssh.knownHostsFile] : [])])] }, async (endpoint, peer, rpc) => {
        if (Object.keys(rpc).some(key => !['id', 'method', 'request', 'afterGeneration', 'preparationId'].includes(key))) throw failure('LOCAL_RPC');
        if (rpc.method === 'runtime') return runtimeState.port.current(options());
        if (rpc.method === 'runtime-change') {
          const iterator = runtimeState.port.changes(rpc.afterGeneration, options());
          try { return (await iterator.next()).value; } finally { await iterator.return(); }
        }
        if (endpoint === 'cli' && rpc.method === 'call') return semantic.accept(peer, rpc.request, options());
        if (endpoint === 'execution' && rpc.method === 'observe') return execution.acceptObservation(peer, rpc.request, options());
        if (endpoint === 'execution' && rpc.method === 'prepare') return execution.prepareObservation(peer, rpc.request, options());
        if (endpoint === 'execution' && rpc.method === 'send-prepared') return execution.sendPrepared(peer, rpc.preparationId, options());
        throw failure('LOCAL_METHOD_DENIED');
      });
      ipc.onClose(error => { closed = true; loseConnection(error); });
      store = new GatewayStore(config.stateRoot, config.storage);
      const { ProjectionCache } = require('./cache.cjs');
      cache = new ProjectionCache({ config: config.cache, authorityId: config.authorityId, authorityEpoch: config.authorityEpoch,
        request, receivedAt: reply => receivedAt.get(reply), accessForPeer: peer => config.readPrincipals.find(item => item.sid === peer.sid)?.principal });
      try { await connect(); return await ready; }
      catch (error) { if (!reconnectTimer) throw error; return await bounded(ready, { timeoutMs: config.startupTimeoutMs }); }
      } catch (error) {
        readyReject(error); closed = true; clearTimeout(reconnectTimer); reconnectTimer = null;
        loseConnection(error); await ipc?.close(); ipc = null; throw error;
      } finally { starting = false; }
    },
    async close() {
      if (closed && !ipc) return; closed = true; clearTimeout(reconnectTimer); reconnectTimer = null;
      loseConnection(failure('DISCONNECTED')); await ipc?.close(); ipc = null;
    },
    health() { return { connected: !!scope && !!link && started, generation: store?.state.generation ?? 0, lastSeen,
      pendingImmutable: store?.pending().length ?? 0, clockId, gatewayInstance, nodeInstance }; },
  };
}
module.exports = { createWindowsGateway };
