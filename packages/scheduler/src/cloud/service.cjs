'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../protocol/contract.cjs');
const deployment = require('../sched/client/deployment-config.cjs');
const load = require('./domain.cjs');
const { createStore, atomicJson, readJson, ensureDirectory, syncDirectory, failure } = require('./storage.cjs');
const { createProtocolStore } = require('./protocol-store.cjs');
const { createFacts } = require('./facts.cjs');
const { createRemote } = require('./remote.cjs');
const { createObjects } = require('./objects.cjs');
const { createLedgerIndex } = require('./ledger-objects.cjs');

function options(value) {
  if (!value || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60000) throw failure('NOT_CONFIGURED', 'CallOptions.timeoutMs must be 1..60000');
  return value;
}
async function deadline(operation, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure('TIMEOUT', 'node request timed out')), ms);
  })]); } finally { clearTimeout(timer); }
}

/** One process owns this service and its cloud-local dataRoot. All remote
 * communication is through sendToNode, outside the synchronous domain fence. */
async function createCloudService({ dataRoot, catalog, authority, sendToNode, fault = () => {}, clock = () => new Date().toISOString(), monotonicClock = () => performance.now() }) {
  if (!path.isAbsolute(dataRoot) || !authority || !Array.isArray(authority.principals) || !authority.principals.length) throw failure('NOT_CONFIGURED', 'explicit root/authority/principals required');
  if (typeof sendToNode !== 'function') throw failure('NOT_CONFIGURED', 'sendToNode is required');
  for (const key of ['id', 'host', 'ownerMachine']) if (typeof authority[key] !== 'string' || !authority[key]) throw failure('NOT_CONFIGURED', `authority.${key} required`);
  if (!Number.isSafeInteger(authority.protocol) || authority.protocol < 1 || !/^[a-f0-9]{40}$/.test(authority.head ?? '')) throw failure('NOT_CONFIGURED', 'authority.protocol and actual build head required');
  if (authority.leaseTtlMs !== undefined && (!Number.isSafeInteger(authority.leaseTtlMs) || authority.leaseTtlMs < 1 || authority.leaseTtlMs > p.MAX_LEASE_TTL_MS)) throw failure('NOT_CONFIGURED', 'lease TTL outside protocol bound');
  p.dispatcherCompatibilityIdentity({ authorityHost: authority.host, ownerMachine: authority.ownerMachine, authorityPid: process.pid,
    protocol: authority.protocol, head: authority.head, createdAt: clock(), createdBy: authority.id });
  const configuration = deployment.validateConfig(catalog);
  deployment.configureDeployment(configuration);
  const principals = new Map(), nodePrincipals = new Map();
  for (const entry of authority.principals) {
    if (principals.has(entry.id) || !entry.readAccess || !entry.nodeIds?.length || !entry.machines?.length) throw failure('NOT_CONFIGURED', 'duplicate or incomplete principal');
    for (const machine of entry.machines) if (!configuration.machines.some(m => m.name === machine)) throw failure('NOT_CONFIGURED', 'principal machine not configured');
    if (entry.readAccess.role === 'node' && (!entry.machines.includes(entry.readAccess.machine)
      || !Array.isArray(entry.readAccess.projects) || entry.readAccess.projects.some(id => !configuration.projects.some(project => project.id === id)))) throw failure('NOT_CONFIGURED', 'principal read scope is not configured');
    for (const node of entry.nodeIds) {
      if (nodePrincipals.has(node)) throw failure('NOT_CONFIGURED', 'node principal mapping is ambiguous');
      nodePrincipals.set(node, entry.id);
    }
    principals.set(entry.id, JSON.parse(p.canonicalJson(entry)));
  }
  const trusted = principal => {
    const fixed = principal && principals.get(principal.id);
    if (!fixed || p.canonicalJson(fixed) !== p.canonicalJson(principal)) throw failure('FENCED', 'principal differs from fixed authentication configuration');
    return fixed;
  };
  const nodeFor = machine => {
    const candidates = [...principals.values()].filter(x => x.role === 'windows' && x.nativeObservation && x.machines.includes(machine));
    const ids = [...new Set(candidates.flatMap(x => x.nodeIds))];
    if (ids.length > 1) throw failure('NOT_CONFIGURED', 'ambiguous machine/node mapping');
    return ids[0] ?? null;
  };
  const principalFor = node => {
    const candidates = [...principals.values()].filter(x => x.role === 'windows' && x.nativeObservation && x.nodeIds.includes(node));
    if (candidates.length !== 1) throw failure('NOT_CONFIGURED', 'node must have one fixed native principal');
    return candidates[0];
  };
  for (const machine of configuration.machines) nodeFor(machine.name);
  ensureDirectory(dataRoot);
  const c = load('sched-contract'), ledger = load('sched-ledger'), control = load('sched-control');
  const sources = { now: clock, nonce: () => randomBytes(24).toString('hex') };
  ledger.initializeScheduler(dataRoot, sources);
  control.createDispatcherConfig(dataRoot, authority.ownerMachine, authority.id, sources);
  const root = path.join(dataRoot, 'cloud-authority');
  const store = createStore(root, { fault });
  const ledgerIndex = createLedgerIndex({ dataRoot, store });
  let daemon, epoch, protocol, remote, objects;
  let closed = false, running = false, timer = null, ticking = null, inCommit = false, lastError = null;
  const facts = createFacts(configuration, monotonicClock, node => {
    const session = store.get('sessions', node); return session?.authorityEpoch === epoch ? session.activeSession : null;
  });
  const originPort = { request: items => remote.originProbe.request(items), pump: () => remote.originProbe.pump(),
    take: () => remote.originProbe.take(), inFlight: () => remote.originProbe.inFlight(), close: () => remote.originProbe.close() };
  const port = {
    readMachines: facts.readMachines, readBeats: facts.readBeats,
    originProbe: originPort,
    reclaim: context => remote.reclaim(context), snapshot: context => remote.snapshot(context), handoff: context => remote.handoff(context),
  };
  const state = () => daemon.state;
  // The remote closure is configured before the daemon creates its probes.
  objects = createObjects({ root, store, authority, get epoch() { return epoch; }, state, now: clock, catalog: configuration, ledgerIndex });
  remote = createRemote({ dataRoot, authority, store, facts, nodeFor, now: clock, state, objects });
  const afterLedger = event => {
    syncDirectory(c.schedPaths(dataRoot).ledger); fault('domain-committed', event); ledgerIndex.record(event);
  };
  daemon = load('sched-daemon').startSchedulerDaemon({ share: dataRoot, machine: authority.ownerMachine, host: authority.host,
    pid: process.pid, protocol: authority.protocol, head: authority.head, sources, mode: 'remote', remote: port,
    hooks: { afterLedger, intake: { afterLedger } } });
  function commit(fn) {
    if (closed || daemon.owner.stopped) throw failure('FENCED', 'authority stopped');
    if (inCommit) throw failure('FENCED', 'nested commit');
    return daemon.commit(context => {
      inCommit = true;
      try { const value = fn(context); if (value?.then) throw failure('FENCED', 'asynchronous commit forbidden'); return value; }
      finally { inCommit = false; }
    });
  }
  try {
    commit(() => {
      store.recover();
      const prior = store.get('meta', 'authority');
      if (prior && prior.id !== authority.id) throw failure('FENCED', 'dataRoot belongs to another authority');
      epoch = (prior?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw failure('FENCED', 'authority epoch exhausted');
      store.put('meta', 'authority', { id: authority.id, epoch });
    });
  } catch (error) { daemon.close(); throw error; }
  try { ledgerIndex.recover({ seq: state().cursor.seq, hash: state().cursor.sha256 }, commit); }
  catch (error) { daemon.close(); throw error; }
  protocol = createProtocolStore(store, authority.id, epoch);
  // Re-create after epoch allocation; read scopes cannot use an undefined epoch.
  objects = createObjects({ root, store, authority, epoch, state, now: clock, catalog: configuration, ledgerIndex });
  remote = createRemote({ dataRoot, authority, store, facts, nodeFor, now: clock, state, objects });
  const cursor = () => ({ seq: state().cursor.seq, hash: state().cursor.sha256 });
  const result = (envelope, status, fields = {}) => ({ ...protocol.identity(envelope), status,
    ...(status === 'durably_received' ? { durableSeq: store.revision() + 1 } : { businessCursor: cursor() }), ...fields });
  const reply = (request, kind, payload, identity) => {
    const response = protocol.envelope(request.nodeId, kind, payload, identity);
    p.validateResponse(request, response); return response;
  };
  function projectAllowed(principal, project) {
    return principal.readAccess.role === 'owner' || principal.readAccess.projects.includes(project);
  }
  function checkBusiness(principal, envelope) {
    const value = envelope.payload, identity = envelope.execution;
    if (identity?.stage === 'submission' && !projectAllowed(principal, identity.project)) throw failure('FENCED', 'source project denied');
    if (envelope.kind === 'submission') {
      if (!projectAllowed(principal, value.project)) throw failure('FENCED', 'submission project denied');
      deployment.assertDeploymentSubmission(value);
      if (!value.allowedMachines.every(m => configuration.machines.some(x => x.name === m))) throw failure('FENCED', 'submission machine denied');
      if (value.origin && !principal.machines.includes(value.origin)) throw failure('FENCED', 'submission origin denied');
      if (!value.origin && !principal.readAccess.machine && principal.machines.length !== 1) throw failure('NOT_CONFIGURED', 'submission source machine is ambiguous');
    }
    const ticketId = identity?.ticketId ?? value.ticketId ?? value.data?.ticketId;
    const ticket = ticketId && state().tickets[ticketId];
    if (ticket && !projectAllowed(principal, ticket.request.project)) throw failure('FENCED', 'ticket project denied');
    if (envelope.kind.startsWith('waiting.')) {
      const original = store.get('submission-identities', ticketId);
      if (!ticket && (!original || original.nodeId !== envelope.nodeId)) throw failure('FENCED', 'waiting ticket source unknown');
      const machine = ticket?.request.origin ?? original?.machine ?? (ticket?.request.allowedMachines.length === 1 ? ticket.request.allowedMachines[0] : null);
      if (!machine || value.machine !== machine) throw failure('FENCED', 'waiting source machine mismatch');
    }
    if (envelope.kind === 'command' && value.data.machine && !principal.machines.includes(value.data.machine)) throw failure('FENCED', 'command machine denied');
    if (identity && identity.stage !== 'submission') {
      const a = ticket?.attempts.find(x => x.attemptId === identity.attemptId);
      const historicalObject = ['artifact.read', 'artifact.chunk', 'log.read', 'log.chunk'].includes(envelope.kind);
      if (!ticket || !historicalObject && ticket.currentAttemptId !== identity.attemptId || !a?.permit || a.permit.token !== identity.permitToken) throw failure('FENCED', 'stale attempt or token');
      const metadata = store.get('snapshot', [ticketId, identity.attemptId]);
      const sourceChunk = envelope.kind === 'artifact.chunk' && ticket.request.origin && principal.machines.includes(ticket.request.origin)
        && metadata?.state === 'ready' && p.canonicalJson(metadata.object) === p.canonicalJson(value.object);
      if (!principal.machines.includes(a.permit.machine) && envelope.kind !== 'snapshot.metadata' && !sourceChunk) throw failure('FENCED', 'execution machine denied');
      if (identity.stage === 'started' && envelope.kind !== 'report.started') {
        const actual = a.controller && { pid: a.controller.pid, creationFileTime: a.controller.creationFileTime };
        if (p.canonicalJson(actual ?? null) !== p.canonicalJson(identity.controller)) throw failure('FENCED', 'controller birth mismatch');
      }
      if (envelope.kind === 'report.started' && ticket.cancelRequested) throw failure('FENCED', 'start cancelled');
      if (envelope.kind === 'snapshot.metadata' && (!ticket.request.origin || !principal.machines.includes(ticket.request.origin))) throw failure('FENCED', 'snapshot source denied');
      if (envelope.kind === 'resident.renewal') {
        if (!ticket.request.resident || p.canonicalJson(store.get('sources', ticketId)) !== p.canonicalJson(identity.source)) throw failure('FENCED', 'resident source mismatch');
        const prior = store.get('resident', [ticketId, identity.attemptId]);
        if (prior?.nodeSession === envelope.nodeSession && p.canonicalJson(prior.identity) !== p.canonicalJson(identity)) throw failure('FENCED', 'resident renewer replaced without new authenticated session');
      }
    }
    return ticket;
  }
  function savePrepared(prepared, receipt) { protocol.commit(prepared, receipt); fault('receipt-committed', receipt); }
  function stage(envelope) {
    const key = p.operationIdentity(envelope).operationKey;
    // Reserve the bounded recovery slot before publishing immutable input. A
    // crash with an empty reservation is harmless; nothing has been ACKed.
    store.reserve(key);
    const prior = store.get('inbox', key);
    if (prior) {
      if (p.operationIdentity(prior).operationHash !== p.operationIdentity(envelope).operationHash) throw failure('FENCED', 'inbox operation conflict');
    } else store.immutable('inbox', key, envelope);
    if (envelope.kind === 'submission') {
      const original = prior ?? envelope, principal = principals.get(nodePrincipals.get(original.nodeId));
      const machine = original.payload.origin ?? principal?.readAccess.machine ?? (principal?.machines.length === 1 ? principal.machines[0] : null);
      store.immutable('submission-identities', c.deriveTicketId(envelope.payload.project, envelope.payload.idempotencyKey),
        { nodeId: original.nodeId, machine, submissionHash: p.contentHash(envelope.payload) });
    }
    return key;
  }
  function materialize(key, envelope) {
    const paths = c.schedPaths(dataRoot), value = envelope.payload;
    switch (envelope.kind) {
      case 'submission': {
        const id = c.deriveTicketId(value.project, value.idempotencyKey);
        if (!store.get('sources', id)) {
          const proof = remote.source(envelope);
          if (!proof) return false;
          if (proof.payload.verdict !== 'verified' || proof.payload.source.submissionHash !== p.contentHash(value)
            || proof.payload.source.observedOwnerSid !== proof.payload.observedOwnerSid) {
            finalize(key, envelope, { status: 'business_rejected', reason: 'original submission source refused' }); return false;
          }
          store.put('sources', id, proof.payload.source);
        }
        const existing = state().submissions[load('sched-project').submissionKey(value.idempotencyKey)];
        if (!existing) load('sched-intake').writeSubmission(dataRoot, value);
        return true;
      }
      case 'command': atomicJson(path.join(paths.commands, `${value.commandId}.json`), value, true); return true;
      case 'report.started': case 'report.finished': {
        const ticket = state().tickets[value.ticketId];
        if (envelope.kind === 'report.finished' && ticket?.cancelRequested && !remote.exited(ticket)) {
          remote.stopPlan(ticket, 'observe', '结束回报核验整树退出'); return false;
        }
        const report = envelope.kind === 'report.started' ? { ...value, creationFileTime: envelope.execution.controller.creationFileTime } : value;
        atomicJson(path.join(paths.reports, c.reportName(report)), report, true); return true;
      }
      case 'snapshot.metadata':
        store.put('snapshot', [value.ticketId, value.attemptId], value); objects.registerSnapshot(envelope); return true;
      case 'launch.notice': atomicJson(load('sched-auto-launch').autoLaunchNoticePath(dataRoot, value.ticketId, value.attemptId), value, true); return true;
      default: throw failure('FENCED', `unsupported inbound immutable ${envelope.kind}`);
    }
  }
  function domainResult(envelope) {
    const v = envelope.payload, paths = c.schedPaths(dataRoot);
    if (envelope.kind === 'submission') {
      const receipt = load('sched-intake').readSubmissionReceipt(dataRoot, v.idempotencyKey);
      if (!receipt) return null;
      return receipt.status === 'accepted' ? { status: 'business_accepted', outcome: { kind: 'submission', ticketId: receipt.ticketId } }
        : { status: 'business_rejected', reason: receipt.reason };
    }
    if (envelope.kind === 'command') {
      const receipt = state().commands[load('sched-project').submissionKey(v.commandId)]?.receipt;
      return !receipt ? null : receipt.status === 'executed'
        ? { status: 'business_accepted', outcome: { kind: 'command', commandId: v.commandId } }
        : { status: 'business_rejected', reason: receipt.reason };
    }
    if (envelope.kind.startsWith('report.')) {
      const receipt = readJson(path.join(paths.reportReceipts, c.reportName(v)));
      return !receipt ? null : receipt.status === 'accepted'
        ? { status: 'business_accepted', outcome: { kind: 'report', ticketId: v.ticketId, attemptId: v.attemptId, phase: v.phase } }
        : { status: 'business_rejected', reason: receipt.reason };
    }
    return { status: 'business_accepted', outcome: { kind: 'applied' } };
  }
  function finalize(key, envelope, outcome) {
    const identity = p.operationIdentity(envelope), prior = store.get('operations', key);
    if (prior?.result && ['business_accepted', 'business_rejected'].includes(prior.result.status)) { store.release(key); return; }
    const receipt = result(envelope, outcome.status, outcome);
    store.put('operations', key, { ...identity, result: receipt });
    fault('receipt-committed', receipt);
    store.release(key);
  }
  function freshSnapshot(principal, envelope) {
    const requested = envelope.payload;
    if (requested.afterCursor.seq > state().cursor.seq) return reply(envelope, 'result', result(envelope, 'business_pending', { reason: 'requested cursor is ahead of authority', retryAfterMs: 1000 }));
    if (requested.afterCursor.seq && ledgerIndex.read(requested.afterCursor.seq, cursor()).sha256 !== requested.afterCursor.hash) throw failure('FENCED', 'projection cursor mismatch');
    const session = store.get('sessions', envelope.nodeId);
    const runtime = store.get('runtime', [epoch, envelope.nodeId, envelope.nodeSession]);
    if (!runtime || !facts.connected(envelope.nodeId)) return reply(envelope, 'result', result(envelope, 'business_pending', { reason: 'runtime instance facts unknown', retryAfterMs: 1000 }));
    const attempts = [];
    for (const ticket of Object.values(state().tickets)) {
      if (!projectAllowed(principal, ticket.request.project)) continue;
      if (requested.ticketId && ticket.ticketId !== requested.ticketId) continue;
      // A complete execution view lists every live grant/execution in scope.
      // Terminal history is in the GUI directory; an explicitly named execution
      // can still obtain its terminal state without an ever-growing live batch.
      if (!requested.ticketId && ticket.endedAt !== null) continue;
      const a = ticket.attempts.at(-1);
      if (!a.permit || !principal.machines.includes(a.permit.machine) || ticket.request.resident || ticket.registerOnly) continue;
      if (!['granted', 'running', 'paused', 'slow', 'passed', 'failed', 'voided', 'cancelled'].includes(ticket.state)) continue;
      const event = ticket.timeline.find(x => x.type === 'granted' && x.attemptId === a.attemptId);
      const identity = a.controller?.creationFileTime ? { stage: 'started', controller: { pid: a.controller.pid, creationFileTime: a.controller.creationFileTime } } : { stage: 'granted' };
      attempts.push({ ...identity, ticketId: ticket.ticketId, attemptId: a.attemptId, permitToken: a.permit.token, state: ticket.state,
        grantedCores: a.grantedCores, permitLedgerSeq: event.seq, cancelRequested: ticket.cancelRequested });
    }
    if (attempts.length > envelope.payload.limit || attempts.length > 1024) throw failure('READ_LIMIT', 'complete projection exceeds bound');
    const payload = { authorityId: authority.id, authorityEpoch: epoch, nodeId: envelope.nodeId, nodeSession: envelope.nodeSession,
      ...runtime, authorityHost: authority.host, ownerMachine: authority.ownerMachine, requestId: envelope.payload.requestId,
      snapshotId: randomUUID(), complete: true, ledgerSeq: state().cursor.seq, businessCursor: cursor(), sessionWatermark: session.lastSequence,
      liveWatermark: session.lastSequence, generatedAt: clock(), attempts };
    return reply(envelope, 'state.snapshot', payload);
  }
  function lease(principal, envelope) {
    const ticket = checkBusiness(principal, envelope), q = envelope.payload, a = ticket?.attempts.at(-1);
    const runtime = { gatewayInstance: q.gatewayInstance, nodeInstance: q.nodeInstance };
    const runtimeKey = [epoch, envelope.nodeId, envelope.nodeSession], old = store.get('runtime', runtimeKey);
    if (old && p.canonicalJson(old) !== p.canonicalJson(runtime)) throw failure('FENCED', 'runtime replacement requires new session');
    // Capture authenticated instance facts even when another event advanced the
    // cursor since started ACK. This permits a fresh projection, not execution.
    if (!old && ticket && !ticket.cancelRequested && facts.connected(envelope.nodeId)) store.put('runtime', runtimeKey, runtime);
    if (!ticket || !['running', 'paused', 'slow'].includes(ticket.state) || ticket.cancelRequested || !facts.connected(envelope.nodeId)
      || q.ledgerSeq !== state().cursor.seq || !a.controller?.creationFileTime || store.get('stop-intents', [ticket.ticketId, a.attemptId])) {
      return reply(envelope, 'result', result(envelope, 'business_rejected', { reason: 'current execution lease unavailable' }));
    }
    const key = [epoch, envelope.nodeId, envelope.nodeSession, ticket.ticketId, a.attemptId];
    const previous = store.get('leases', key);
    if (previous && q.challengeSequence <= previous.challengeSequence) throw failure('FENCED', 'lease challenge replay');
    const payload = { authorityId: authority.id, authorityEpoch: epoch, nodeId: envelope.nodeId, nodeSession: envelope.nodeSession,
      ...runtime, ...envelope.execution, ledgerSeq: q.ledgerSeq, challenge: q.challenge, challengeSequence: q.challengeSequence,
      leaseId: randomUUID(), leaseSequence: (previous?.leaseSequence ?? 0) + 1,
      ttlMs: Math.min(q.requestedTtlMs, authority.leaseTtlMs ?? p.DEFAULT_LEASE_TTL_MS, p.MAX_LEASE_TTL_MS) };
    store.commit(store.revision(), [{ table: 'runtime', key: [epoch, envelope.nodeId, envelope.nodeSession], value: runtime }, { table: 'leases', key, value: payload }]);
    return reply(envelope, 'lease.renewal', payload, envelope.execution);
  }
  async function accept(principalInput, envelope, callOptions) {
    options(callOptions); const principal = trusted(principalInput);
    const prepared = protocol.prepare(envelope, principal, monotonicClock());
    if (prepared.status === 'rejected') throw failure('FENCED', prepared.reason);
    if (prepared.status === 'ignored' && p.IMMUTABLE_KINDS.includes(envelope.kind)) throw failure('FENCED', prepared.reason);
    // Untrusted/obsolete input is refused before entering owner.commit; it
    // cannot poison the single writer's lease. IO/CAS failures still fence it.
    if (prepared.status === 'ready') checkBusiness(principal, envelope);
    if (['origin.proof', 'process.stop-proof', 'handoff.observe', 'snapshot.metadata', 'artifact.chunk', 'log.chunk', 'result'].includes(envelope.kind)) {
      const request = store.get('requests', envelope.kind === 'result' ? envelope.payload.messageId : envelope.payload.requestId);
      if (!request) throw failure('FENCED', 'unsolicited node reply');
      p.validateResponse(request, envelope);
    }
    return commit(() => {
      if (prepared.status === 'duplicate' && prepared.operation) {
        const replay = prepared.replayResult ? p.replayResult(prepared) : result(envelope, 'durably_received');
        savePrepared(prepared, replay); return reply(envelope, 'result', replay);
      }
      if (prepared.status === 'duplicate' && prepared.replayResult) return reply(envelope, 'result', p.replayResult(prepared));
      if (prepared.status !== 'ready') {
        const denied = result(envelope, 'business_rejected', { reason: prepared.reason ?? 'message not new' });
        savePrepared(prepared, denied); return reply(envelope, 'result', denied);
      }
      if (prepared.operation) {
        stage(envelope);
        const receipt = result(envelope, 'durably_received');
        savePrepared(prepared, receipt); return reply(envelope, 'result', receipt);
      }
      let receipt = result(envelope, 'business_accepted', { outcome: { kind: 'applied' } }), response;
      try {
        if (envelope.kind === 'projection.catalog') response = reply(envelope, 'projection.manifest', objects.catalog(principal, envelope));
        if (envelope.kind === 'projection.read') response = reply(envelope, 'projection.chunk', objects.read(principal, envelope));
        if (['artifact.read', 'log.read'].includes(envelope.kind)) response = reply(envelope,
          envelope.kind === 'log.read' ? 'log.chunk' : 'artifact.chunk', objects.directRead(principal, envelope), envelope.execution);
        if (envelope.kind === 'state.read') response = freshSnapshot(principal, envelope);
        if (envelope.kind === 'lease.challenge') response = lease(principal, envelope);
        if (envelope.kind === 'result' && envelope.payload.operationKey !== null) {
          const prior = store.get('out-operations', envelope.payload.operationKey);
          if (!prior || prior.operationHash !== envelope.payload.operationHash) throw failure('FENCED', 'outbound operation receipt mismatch');
          if (prior.result && ['business_accepted', 'business_rejected'].includes(prior.result.status)) {
            const { messageId: ignoredId, envelopeHash: ignoredHash, ...oldBusiness } = prior.result;
            const { messageId: newId, envelopeHash: newHash, ...newBusiness } = envelope.payload;
            if (p.canonicalJson(oldBusiness) !== p.canonicalJson(newBusiness)) throw failure('FENCED', 'outbound operation result changed');
          } else store.put('out-operations', envelope.payload.operationKey, { ...prior, result: envelope.payload });
        }
        if (envelope.kind === 'resident.renewal') store.put('resident', [envelope.execution.ticketId, envelope.execution.attemptId], { identity: envelope.execution, nodeSession: envelope.nodeSession });
      } catch (error) {
        // A refused read/challenge is a business refusal. Storage errors remain
        // uncaught and fence the writer; they must never become a success ACK.
        if (!['FENCED', 'READ_LIMIT'].includes(error.code)) throw error;
        receipt = result(envelope, 'business_rejected', { reason: error.message });
      }
      if (response?.kind === 'result') receipt = response.payload;
      savePrepared(prepared, receipt);
      if (receipt.status === 'business_accepted' && p.LIVE_ONLY_KINDS.includes(envelope.kind)) facts.put(envelope);
      return response ?? reply(envelope, 'result', receipt);
    });
  }
  async function issue(principalInput, request, callOptions) {
    options(callOptions); const principal = trusted(principalInput);
    if (inCommit) throw failure('FENCED', 'network in commit forbidden');
    p.encodeFrame(request);
    if (!['origin.request', 'process.stop-request', 'handoff.intent', 'handoff.publish', 'handoff.observe-request', 'handoff.quarantine', 'snapshot.request', 'artifact.read', 'log.read'].includes(request.kind)) throw failure('FENCED', 'not a cloud request');
    if (closed || request.authorityEpoch !== epoch || request.authorityId !== authority.id || !principal.nodeIds.includes(request.nodeId)) throw failure('FENCED', 'outbound authority mismatch');
    const session = store.get('sessions', request.nodeId);
    if (session?.activeSession !== request.nodeSession || session.authorityEpoch !== epoch) throw failure('FENCED', 'outbound session mismatch');
    const operation = p.IMMUTABLE_KINDS.includes(request.kind) ? p.operationIdentity(request) : null;
    const prior = operation && store.get('out-operations', operation.operationKey);
    if (prior && prior.operationHash !== operation.operationHash) throw failure('FENCED', 'outbound operation conflict');
    commit(() => store.commit(store.revision(), [
      { table: 'requests', key: request.messageId, value: request },
      { table: 'requests', key: request.payload.requestId, value: request },
      ...(operation ? [{ table: 'out-operations', key: operation.operationKey, value: prior ?? { ...operation, result: null } }] : []),
    ]));
    const response = await deadline(() => sendToNode(request.nodeId, request, callOptions), callOptions.timeoutMs);
    p.validateResponse(request, response);
    // Re-enter the fence only after transport has completed. Revalidate epoch,
    // session, sequence and principal before exposing any observation to a tick.
    const ack = await accept(principal, response, callOptions);
    if (!['business_accepted', 'durably_received'].includes(ack.payload.status)) {
      const saved = response.kind === 'result' && response.payload.operationKey !== null
        ? store.get('out-operations', response.payload.operationKey)?.result : null;
      const business = value => { const { messageId, envelopeHash, ...rest } = value; return rest; };
      if (!saved || p.canonicalJson(business(saved)) !== p.canonicalJson(business(response.payload))) throw failure('FENCED', 'reply was not accepted by current authority');
    }
    return response;
  }
  async function sendPlan(plan) {
    if (!facts.connected(plan.nodeId)) throw failure('DISCONNECTED', 'node facts unknown');
    const request = commit(() => protocol.envelope(plan.nodeId, plan.kind, plan.payload, plan.execution));
    const response = await issue(principalFor(plan.nodeId), request, { timeoutMs: plan.payload.timeoutMs });
    if (response.kind === 'result' && p.IMMUTABLE_KINDS.includes(plan.kind)) commit(() => store.put('plan-results', plan.key, response.payload));
    return response;
  }
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      commit(() => {
        for (const key of store.pending()) {
          const envelope = store.get('inbox', key);
          if (!envelope) { store.release(key); continue; }
          const prior = store.get('operations', key);
          if (prior?.result && ['business_accepted', 'business_rejected'].includes(prior.result.status)) { store.release(key); continue; }
          if (materialize(key, envelope)) store.put('materialized', key, true);
        }
      });
      inCommit = true;
      try { daemon.tick(); } finally { inCommit = false; }
      commit(() => {
        for (const key of store.pending()) {
          const envelope = store.get('inbox', key); if (!envelope || !store.get('materialized', key)) continue;
          const outcome = domainResult(envelope); if (outcome) finalize(key, envelope, outcome);
        }
      });
      await remote.pump(sendPlan);
      await objects.pump(async (item, payload) => {
        const request = commit(() => protocol.envelope(item.nodeId, item.kind === 'log-segment' ? 'log.read' : 'artifact.read', payload, item.execution));
        return issue(principalFor(item.nodeId), request, { timeoutMs: 10000 });
      }, commit);
      return true;
    })();
    try { return await ticking; } catch (error) { lastError = { code: error.code ?? 'IO_FAILURE', message: error.message }; throw error; }
    finally { ticking = null; }
  }
  function start() {
    if (closed) throw failure('FENCED', 'closed authority cannot restart');
    if (running) return;
    running = true;
    const loop = async () => {
      timer = null; if (closed) return;
      try { await tick(); } catch { closed = true; running = false; daemon.close(); return; }
      if (!closed) { timer = setTimeout(loop, c.DISPATCH_TICK_MS); timer.unref?.(); }
    };
    timer = setTimeout(loop, 0); timer.unref?.();
  }
  async function close() {
    if (closed) return;
    closed = true; running = false; clearTimeout(timer); timer = null;
    daemon.close(); // immediately fence; an outstanding response cannot commit
    if (ticking) await ticking.catch(() => {});
  }
  const only = kind => (principal, envelope, callOptions) => {
    if (envelope?.kind !== kind) return Promise.reject(failure('FENCED', `port requires ${kind}`));
    return accept(principal, envelope, callOptions);
  };
  return { authority: { accept, issue, snapshot: only('state.read'), leaseReply: only('lease.challenge') }, start, tick, close,
    health: () => ({ authorityId: authority.id, authorityEpoch: epoch, authorityHost: authority.host, ownerMachine: authority.ownerMachine,
      mode: 'remote', stopped: closed || daemon.owner.stopped, cursor: cursor(), pending: store.pending().length,
      readCache: objects.cacheUsage(), lastError }) };
}
module.exports = { createCloudService };
