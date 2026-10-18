'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const { createNativeGate, suspensionTree } = require('./native.cjs');
const { createObjectStore, bindingKey } = require('./objects.cjs');
const { commandFromCatalog, jobEnvironment } = require('./command.cjs');
const snapshot = require('../sched/client/sched-snapshot.cjs');
const deployment = require('../sched/client/deployment-config.cjs');
const sources = require('./sources.cjs');
const { createNodeReader } = require('./reader.cjs');
const same = (a, b) => p.canonicalJson(a) === p.canonicalJson(b);
const scopeKeys = ['authorityId', 'authorityEpoch', 'nodeId', 'nodeSession', 'gatewayInstance', 'nodeInstance'];
const scopeMatches = (a, b) => scopeKeys.every(key => a[key] === b[key]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createWindowsNode({ config, gateway, dependencies = {} }) {
  if (config.mode !== 'remote') throw new Error('NODE_REMOTE_MODE_REQUIRED');
  for (const name of ['stateRoot', 'lifecycleRoot', 'artifactRoot', 'snapshotRoot'])
    if (!path.isAbsolute(config[name] ?? '')) throw new Error(`NODE_CONFIG_${name}`);
  if (!gateway?.execution?.prepareObservation || !gateway.runtime || !gateway.replyTo || !gateway.port) throw new Error('GATEWAY_PORTS_REQUIRED');
  const options = { timeoutMs: config.timeoutMs ?? 12000 };
  const objects = createObjectStore({ root: path.join(config.stateRoot, 'objects'), maxObjectBytes: config.maxObjectBytes });
  const executions = new Map(), snapshotOperations = new Map();
  const reader = dependencies.reader ?? createNodeReader(gateway, config);
  let lifecycle, notice, active = false, timer, ticking, fault = null, observationSequence = 0, reconnecting, ciObserver, loadSampler, localRuns;
  let lastMachineObservation = 0, handoffs, startTask, closeTask;
  async function bounded(work) {
    let timeout;
    try { return await Promise.race([work, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('NODE_OPERATION_TIMEOUT')), Math.min(options.timeoutMs, 60000));
    })]); } finally { clearTimeout(timeout); }
  }
  async function current() {
    const value = await gateway.runtime.current(options);
    if (notice && value.generation < notice.generation) throw new Error('RUNTIME_GENERATION_ROLLBACK');
    if (value.connection !== 'connected' || notice && (value.generation !== notice.generation || !scopeMatches(value.scope, notice.scope))) {
      if (!reconnecting) {
        reconnecting = fenceAll().finally(() => { reconnecting = null; });
      }
      await reconnecting;
      if (value.connection !== 'connected') throw new Error('GATEWAY_DISCONNECTED');
    }
    notice = value;
    return value;
  }
  async function fenceAll() {
    const outcomes = await Promise.allSettled([...executions.values()].map(async entry => {
      entry.fenced = true;
      if (entry.exitFact?.verdict === 'tree-exited') return;
      await bounded(entry.prepared.catch(() => {}).then(() => entry.native?.fence()));
    }));
    if (outcomes.some(x => x.status === 'rejected')) fault = 'NATIVE_FENCE_UNCONFIRMED';
  }
  async function tick() {
    if (!active || ticking) return ticking;
    ticking = (async () => {
      try {
        try { lifecycle.renew(); } catch (error) { active = false; await fenceAll(); throw error; }
        await current();
        if (performance.now() - lastMachineObservation >= 5000) {
          const load = { schema: 1, ci: ciObserver.read(), ...loadSampler.read(),
            ...(loadSampler.readMemory() ? { memory: loadSampler.readMemory() } : {}) };
          const running = [...executions.values()].filter(entry => !entry.finished && !entry.fenced).length;
          const snapshot = lifecycle.heartbeat(load, running, config.maxJobs ?? 4);
          const payload = { machine: config.machine, observedAt: new Date().toISOString(), observationSequence: ++observationSequence,
            lifecycle: { ...snapshot, machines: snapshot.machines.map(m => ({ ...m, heartbeat: m.heartbeat ?? null })) } };
          await gateway.execution.acceptObservation(await gateway.localExecutionPeer(), { kind: 'machine.observation', payload }, options);
          lastMachineObservation = performance.now();
        }
      }
      catch (error) { fault = error.message; }
    })();
    try { await ticking; } finally { ticking = null; }
  }
  function receipt(request, status, reason) {
    const operation = p.operationIdentity(request);
    return { messageId: request.messageId, envelopeHash: request.contentHash, ...operation,
      businessCursor: { seq: 0, hash: null }, status,
      ...(status === 'business_accepted' ? { outcome: { kind: 'applied' } }
        : status === 'business_pending' ? { reason, retryAfterMs: 1000 } : { reason }) };
  }
  async function reply(request, kind, payload) {
    p.validateRequest(kind, payload);
    return gateway.replyTo(request, kind, payload, kind === 'result' ? undefined : request.execution);
  }
  async function observeHandoff(request) {
    const input = request.payload;
    const base = { submissionId: input.submissionId, ownerMachine: input.ownerMachine, authorityHost: input.authorityHost,
      intentId: input.intentId, lifecycleEpoch: input.lifecycleEpoch, requestId: input.requestId,
      observationSequence: ++observationSequence, observedAt: new Date().toISOString() };
    try {
      const observed = lifecycle.observe(input);
      const body = { ...base, state: observed.state, identity: observed.identity };
      if (observed.record?.result) {
        const result = require('../bot/cluster-agent-node-lifecycle.js').extractNodeJobResult(observed.record, observed.identity);
        body.result = result;
        if (Object.hasOwn(result, 'exitCode')) body.exitCode = result.exitCode;
        const directory = path.join(config.stateRoot, 'attempts', request.execution.ticketId, request.execution.attemptId);
        await fs.mkdir(directory, { recursive: true });
        // The jobs-v12 envelope remains in the original lifecycle record. The
        // wire object is the validated result body plus its suspension evidence.
        const resultFile = path.join(directory, 'job-result.json'), bytes = p.canonicalJson({ ...result,
          ...(observed.record.result.suspension === undefined ? {} : { suspension: observed.record.result.suspension }) });
        try {
          const fd = await fs.open(resultFile, 'wx');
          try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
        } catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(resultFile, 'utf8') !== bytes) throw error; }
        body.resultObject = await objects.publish(request.execution, directory, 'job-result.json');
        const artifactObjects = await objects.artifacts(request.execution, result.artifacts,
          path.join(config.artifactRoot, request.execution.ticketId, request.execution.attemptId));
        if (artifactObjects) body.artifactObjects = artifactObjects;
      }
      const entry = executions.get(bindingKey(request.execution));
      if (entry?.directory) {
        const name = await require('./output.cjs').journal(entry);
        body.log = await objects.publish(request.execution, entry.directory, name);
      }
      return reply(request, 'handoff.observe', body);
    } catch (error) {
      fault = `HANDOFF_OBSERVATION:${error.message}`;
      return reply(request, 'handoff.observe', { ...base, state: 'unknown', identity: null });
    }
  }
  async function processStop(request) {
    let verdict = 'unknown';
    const entry = executions.get(bindingKey(request.execution));
    if (entry) {
      try {
        await entry.prepared;
        if (same(entry.identity, request.execution)) {
          if (entry.exitFact?.verdict === 'tree-exited') verdict = 'tree-exited';
          else {
            if (request.payload.action === 'stop') await entry.native.stop(request.execution);
            const deadline = performance.now() + Math.min(request.payload.timeoutMs, options.timeoutMs);
            do {
              const fact = await entry.native.poll(request.execution); verdict = fact.verdict;
              if (verdict !== 'alive' || request.payload.action === 'observe' || performance.now() >= deadline) break;
              await sleep(50);
            } while (true);
          }
        }
      } catch (error) { fault = `PROCESS_OBSERVATION:${error.message}`; verdict = 'unknown'; }
    }
    const body = { machine: config.machine, requestId: request.payload.requestId, observationSequence: ++observationSequence,
      observedAt: new Date().toISOString(), verdict, method: 'windows-job-object' };
    return reply(request, 'process.stop-proof', { ...body, evidenceHash: p.contentHash({ ...body, identity: request.execution }) });
  }
  async function buildSnapshotBody(request) {
    const input = request.payload, binding = request.execution;
    const base = { schema: 1, ticketId: binding.ticketId, attemptId: binding.attemptId, requestId: input.requestId, createdAt: new Date().toISOString() };
    const project = deployment.getDeploymentConfig().projects.find(x => x.id === input.project);
    if (!project?.accepted || !project.machines.includes(config.machine)) throw new Error('SNAPSHOT_PROJECT_DENIED');
    const ticket = await reader.ticket(binding.ticketId);
    if (!ticket) throw new Error('SNAPSHOT_SUBMISSION_UNKNOWN');
    const source = await sources.original(gateway, sources.submissionIdentity(ticket.request), undefined, options);
    if (!same(await sources.codeAt(source.cwd, source.request), input.codeRef)) throw new Error('SNAPSHOT_CODE_REF_MISMATCH');
    const directory = path.join(config.snapshotRoot, binding.ticketId, binding.attemptId);
    await fs.mkdir(directory, { recursive: true });
    const made = await snapshot.createSnapshot({ repoPath: source.cwd, ticketId: binding.ticketId, tempDir: directory, timeoutMs: input.timeoutMs });
    if (!made.ok) return { ...base, state: 'refused', reason: made.reason, detail: made.detail ?? made.reason };
    if (input.codeRef.kind === 'commit' && made.parent !== input.codeRef.value) return { ...base, state: 'refused',
      reason: 'CODE_REF_MISMATCH', detail: 'Configured project HEAD differs from the requested commit' };
    const trunk = (await reader.read([{ kind: 'project-trunk-head', project: input.project }])).objects[0]?.value;
    if (typeof trunk !== 'string' || !/^[a-f0-9]{40}$/.test(trunk)) throw new Error('SNAPSHOT_TRUNK_UNKNOWN');
    const bundled = await snapshot.createBundle({ repoPath: source.cwd, ticketId: binding.ticketId, mainCommit: trunk,
      destDir: directory, timeoutMs: input.timeoutMs });
    if (!bundled.ok) return { ...base, state: 'refused', reason: bundled.reason, detail: bundled.detail ?? bundled.reason };
    if (!same(await sources.codeAt(source.cwd, source.request), input.codeRef)) throw new Error('SNAPSHOT_SOURCE_CHANGED');
    const object = await objects.publish(binding, directory, `${binding.ticketId}.bundle`);
    return { ...base, state: 'ready', commit: made.commit, base: bundled.base,
      object, bundle: `${binding.ticketId}.bundle`, bundleBytes: object.size };
  }
  async function snapshotRequest(request) {
    const key = p.contentHash({ identity: request.execution, requestId: request.payload.requestId });
    const hash = p.contentHash({ identity: request.execution, payload: request.payload });
    if (snapshotOperations.has(key)) {
      const existing = snapshotOperations.get(key);
      if (existing.hash !== hash) throw new Error('SNAPSHOT_OPERATION_CHANGED');
      return reply(request, 'snapshot.metadata', await existing.work);
    }
    const work = (async () => {
      const directory = path.join(config.stateRoot, 'snapshot-operations'), file = path.join(directory, key + '.json');
      await fs.mkdir(directory, { recursive: true });
      try {
        const claim = await fs.open(file, 'wx');
        try { await claim.writeFile(p.canonicalJson({ hash, state: 'pending' })); await claim.sync(); } finally { await claim.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = JSON.parse(await fs.readFile(file, 'utf8'));
        if (prior.hash !== hash) throw new Error('SNAPSHOT_OPERATION_CHANGED');
        if (prior.state !== 'complete') throw new Error('SNAPSHOT_PREVIOUS_OPERATION_UNKNOWN');
        return p.validateRequest('snapshot.metadata', prior.payload);
      }
      const payload = p.validateRequest('snapshot.metadata', await buildSnapshotBody(request));
      const stage = file + '.' + randomUUID();
      const fd = await fs.open(stage, 'wx');
      try { await fd.writeFile(p.canonicalJson({ hash, state: 'complete', payload })); await fd.sync(); } finally { await fd.close(); }
      await fs.rename(stage, file); return payload;
    })();
    snapshotOperations.set(key, { hash, work });
    return reply(request, 'snapshot.metadata', await work);
  }
  const api = {
    start() {
      if (closeTask) return Promise.reject(new Error('NODE_INSTANCE_CLOSED'));
      if (startTask) return startTask;
      startTask = (async () => {
      if (notice) throw new Error('NODE_INSTANCE_CANNOT_RESTART');
      notice = await current();
      lifecycle = dependencies.lifecycle ?? require('../bot/cluster-agent-node-lifecycle.js').createNodeLifecycle({
        share: config.lifecycleRoot, machine: config.machine, head: config.head });
      lifecycle.start(); active = true;
      ciObserver = dependencies.ciObserver ?? require('../bot/cluster-agent-ci-observer.js').createAgentCiObserver();
      loadSampler = dependencies.loadSampler ?? require('../bot/cluster-agent-load.js').createAgentLoadSampler();
      ciObserver.start(); loadSampler.start();
      localRuns = require('./local-execution.cjs').createLocalExecutions({ config, gateway, node: api, reader, executions, current, ciObserver, lifecycle, dependencies });
      handoffs = require('./handoff.cjs').createHandoffRunner({ config, lifecycle, reader, localRuns, current,
        onFault: message => { fault = message; } });
      timer = setInterval(() => { void tick().catch(error => { fault = error.message; }); }, 1000);
      })();
      return startTask;
    },
    close() {
      if (closeTask) return closeTask;
      closeTask = (async () => {
      if (startTask) await startTask.catch(() => {});
      active = false; clearInterval(timer); if (ticking) await ticking;
      ciObserver?.stop(); loadSampler?.stop(); localRuns?.close();
      const handoffClosing = handoffs?.close();
      await fenceAll();
      const outcomes = await Promise.allSettled([...executions.values()].map(async entry => {
        await bounded(entry.prepared.catch(() => {}).then(() => entry.native?.close()));
      }));
      if (handoffClosing) await bounded(handoffClosing);
      lifecycle?.close();
      if (outcomes.some(x => x.status === 'rejected')) throw new Error('NODE_CLOSE_UNKNOWN');
      })();
      return closeTask;
    },
    health: () => ({ active, fault, generation: notice?.generation ?? null, executions: executions.size }),
    async handleCloudRequest(request) {
      if (!active) throw new Error('NODE_NOT_STARTED');
      await current(); p.decodeFrame(p.encodeFrame(request));
      if (['authorityId', 'authorityEpoch', 'nodeId', 'nodeSession'].some(key => request[key] !== notice.scope[key])) throw new Error('REQUEST_SCOPE');
      if (request.payload.machine !== undefined && request.payload.machine !== config.machine) throw new Error('REQUEST_MACHINE');
      switch (request.kind) {
        case 'handoff.intent':
          // Intent is not publication. Cloud durably retains it until publish.
          return reply(request, 'result', receipt(request, 'business_accepted'));
        case 'handoff.publish': {
          const observation = lifecycle.publish(request.payload);
          if (observation.state === 'inbox') await handoffs.accept(request.payload);
          return reply(request, 'result', receipt(request, ['claim', 'transition', 'unknown'].includes(observation.state)
            ? 'business_pending' : 'business_accepted', 'LIFECYCLE_UNRESOLVED'));
        }
        case 'handoff.observe-request': return observeHandoff(request);
        case 'handoff.quarantine': {
          const observation = lifecycle.quarantine(request.payload);
          return reply(request, 'result', receipt(request, observation.state === 'quarantine' ? 'business_accepted' : 'business_pending', 'QUARANTINE_UNRESOLVED'));
        }
        case 'process.stop-request': return processStop(request);
        case 'artifact.read': case 'log.read':
          return reply(request, request.kind === 'artifact.read' ? 'artifact.chunk' : 'log.chunk',
            await objects.read(request.execution, request.payload, request.kind));
        case 'snapshot.request': return snapshotRequest(request);
        case 'origin.request': {
          const base = { machine: config.machine, ownerMachine: config.machine, requestId: request.payload.requestId,
            observationSequence: ++observationSequence, observedAt: new Date().toISOString(), codeRef: request.payload.codeRef };
          try {
            const source = await sources.original(gateway, request.execution, request.payload.source, options);
            const observed = await sources.codeAt(source.cwd, source.request);
            return reply(request, 'origin.proof', { ...base, verdict: same(observed, request.payload.codeRef) ? 'verified' : 'mismatch',
              observedOwnerSid: source.source.observedOwnerSid, source: source.source });
          } catch (error) { return reply(request, 'origin.proof', { ...base, verdict: 'unknown', detail: error.message.slice(0, 500), source: null }); }
        }
        default: throw new Error('NODE_REQUEST_KIND');
      }
    },
    // An internal execution consumer, not a LocalClientPort operation. Supplying
    // the OS peer and fresh projection context comes from gateway, never from
    // the cloud job payload or the ordinary CLI caller.
    async prepareExecution({ identity, project, job, codeRef, observeCi, intent, command: localCommand, requestHash }) {
      if (!active) throw new Error('NODE_NOT_STARTED');
      await current(); const key = bindingKey(identity);
      if (executions.has(key)) {
        if (executions.get(key).requestHash !== requestHash) throw new Error('ATTEMPT_COMMAND_CONFLICT');
        return executions.get(key).prepared;
      }
      if (typeof observeCi !== 'function' || !intent || typeof intent.manual !== 'boolean' || typeof intent.ownerHold !== 'boolean')
        throw new Error('CURRENT_SUSPENSION_FACTS_REQUIRED');
      const peer = await gateway.localExecutionPeer();
      if (executions.has(key)) {
        if (executions.get(key).requestHash !== requestHash) throw new Error('ATTEMPT_COMMAND_CONFLICT');
        return executions.get(key).prepared;
      }
      const entry = { native: null, suspension: null, peer, scope: structuredClone(notice.scope), generation: notice.generation,
        requestHash, codeRef, grantedCores: job.grantedCores, identity: null, started: null, startedObservation: null,
        ack: null, preparationId: null, challengeSequence: 0, released: false, inFlight: null };
      entry.prepared = (async () => {
        if (job.ticketId !== identity.ticketId || !Number.isSafeInteger(job.grantedCores) || job.grantedCores < 1) throw new Error('JOB_PERMIT_BINDING');
        const command = localCommand ?? await commandFromCatalog({ project, job, machine: config.machine, codeRef, share: config.lifecycleRoot });
        entry.command = command;
        const directory = path.join(config.stateRoot, 'attempts', identity.ticketId, identity.attemptId);
        entry.directory = directory;
        // A permanent reservation survives crashes. Unknown previous trees are
        // never adopted, erased or restarted under the same attempt.
        await fs.mkdir(directory, { recursive: true });
        const claim = await fs.open(path.join(directory, 'execution.claim'), 'wx');
        try { await claim.writeFile(p.canonicalJson({ identity, scope: notice.scope })); await claim.sync(); } finally { await claim.close(); }
        const recordFile = path.join(directory, 'suspension.json');
        const env = { ...(localCommand ? localCommand.env : jobEnvironment({ command, directory, identity, cores: job.grantedCores })),
          SCHED_MODE: 'remote', SCHED_PERMIT: `${identity.ticketId}:${identity.attemptId}:${identity.permitToken}`,
          SCHED_GRANTED_CORES: String(job.grantedCores), SCHED_SUSPEND_RECORD: recordFile,
          ...(config.clientConfigPath ? { SCHED_REMOTE_CONFIG: config.clientConfigPath } : {}) };
        const native = (dependencies.nativeFactory ?? createNativeGate)({ scope: entry.scope, directory, executable: command.executable,
          args: command.args, cwd: command.cwd, env, maxLogBytes: config.maxLogBytes ?? 64 * 1024 * 1024,
          permitAuthorityFactory: birth => require('../sched/sched-permit-authority.js').createPermitAuthority(birth) }); entry.native = native;
        const { SuspensionController } = require('../sched/sched-suspend.js');
        const { SuspendStore } = require('../sched/sched-suspend-store.js');
        const controller = new SuspensionController({ store: new SuspendStore(recordFile), native: suspensionTree(native, identity),
          warn: message => { fault = message; } });
        entry.suspension = controller;
        await controller.manage({ ticketId: identity.ticketId, attemptId: identity.attemptId, token: identity.permitToken,
          machine: config.machine, share: config.lifecycleRoot, category: command.item.category, ownerPid: process.pid,
          command: command.executable, args: command.args, cwd: command.cwd, env, ciAware: job.ciAware, remoteStartGate: true }, intent, observeCi);
        const prepared = await native.prepare(identity); entry.identity = prepared.identity;
        entry.verifier = prepared.verifier; entry.root = prepared.root;
        return { gateId: native.gateId, identity: prepared.identity, controller: prepared.controller, root: prepared.root };
      })();
      executions.set(key, entry); return entry.prepared;
    },
    releaseExecution(identity, projectionContext) {
      const entry = executions.get(bindingKey(identity));
      if (!entry) throw new Error('UNKNOWN_EXECUTION');
      if (entry.inFlight) return entry.inFlight;
      const task = (async () => {
      await current();
      await entry.prepared;
      if (entry.fenced || entry.generation !== notice.generation || !scopeMatches(entry.scope, notice.scope)) throw new Error('EXECUTION_FENCED');
      if (!same(identity, entry.identity)) throw new Error('EXECUTION_IDENTITY');
      if (!entry.startedObservation) {
        const payload = { phase: 'started', ticketId: identity.ticketId, attemptId: identity.attemptId, token: identity.permitToken,
          machine: config.machine, pid: identity.controller.pid, creationFileTime: identity.controller.creationFileTime,
          codeRef: entry.codeRef, at: new Date().toISOString(), ...(entry.verifier ? { verifier: entry.verifier } : {}) };
        entry.startedObservation = { kind: 'report.started', identity, payload };
      }
      if (!entry.preparationId && !entry.ack) {
        const prepared = await gateway.execution.prepareObservation(entry.peer, entry.startedObservation, options);
        entry.started = prepared.envelope; entry.preparationId = prepared.preparationId;
      }
      if (!entry.ack) {
        let sent;
        try { sent = await gateway.execution.sendPrepared(entry.peer, entry.preparationId, options); }
        catch (error) {
          // Next explicit retry prepares the SAME immutable observation. The
          // gateway may allocate a new frame; business identity/body and tree
          // remain unchanged. A changed RuntimeScope still fences this attempt.
          entry.preparationId = null; throw error;
        }
        if (!same(sent.envelope, entry.started) || sent.reply.kind !== 'result') throw new Error('STARTED_REPLY');
        p.validateResponse(entry.started, sent.reply);
        const ack = p.validateResult(sent.reply.payload);
        if (ack.status !== 'business_accepted') { entry.preparationId = null; throw new Error('STARTED_NOT_ACCEPTED'); }
        entry.ack = ack;
      }
      if (!entry.runtimeBound) {
        // Cloud binds the authenticated native runtime from this challenge even
        // when its cursor cannot yet grant a lease. This is never release authority.
        const payload = { challenge: randomUUID(), challengeSequence: ++entry.challengeSequence,
          ledgerSeq: entry.ack.businessCursor.seq, requestedTtlMs: p.DEFAULT_LEASE_TTL_MS,
          gatewayInstance: entry.scope.gatewayInstance, nodeInstance: entry.scope.nodeInstance };
        const prepared = await gateway.execution.prepareObservation(entry.peer, { kind: 'lease.challenge', identity, payload }, options);
        await entry.native.recordChallengeSend(entry.native.gateId, prepared.envelope);
        const sent = await gateway.execution.sendPrepared(entry.peer, prepared.preparationId, options);
        if (!same(sent.envelope, prepared.envelope)) throw new Error('BOOTSTRAP_CHALLENGE_CHANGED');
        p.validateResponse(prepared.envelope, sent.reply);
        // A result may refuse the stale cursor. We only proceed to a fresh read;
        // a second challenge and native acceptance remain mandatory below.
      }
      if (!projectionContext) {
        const response = await gateway.readProjection({ requestId: randomUUID(), afterCursor: entry.ack.businessCursor,
          limit: 1024, ticketId: identity.ticketId }, options);
        if (response.kind !== 'state.snapshot') throw new Error('PROJECTION_UNAVAILABLE');
        projectionContext = { ...entry.scope, minLedgerSeq: entry.minLedgerSeq ?? 0, minBusinessCursor: entry.ack.businessCursor.seq,
          minSessionWatermark: entry.minSessionWatermark ?? 0, minLiveWatermark: entry.minLiveWatermark ?? 0 };
      }
      const view = gateway.port.readFreshProjection(projectionContext);
      if (!view.allowed) throw new Error(view.reason);
      const projection = p.validateProjection(view.projection);
      entry.runtimeBound = true;
      entry.minLedgerSeq = projection.ledgerSeq; entry.minSessionWatermark = projection.sessionWatermark; entry.minLiveWatermark = projection.liveWatermark;
      if (projection.attempts.find(x => x.ticketId === identity.ticketId && x.attemptId === identity.attemptId)?.grantedCores !== entry.grantedCores)
        throw new Error('PROJECTED_CORES_MISMATCH');
      const payload = { challenge: randomUUID(), challengeSequence: ++entry.challengeSequence, ledgerSeq: projection.ledgerSeq,
        requestedTtlMs: p.DEFAULT_LEASE_TTL_MS, gatewayInstance: notice.scope.gatewayInstance, nodeInstance: notice.scope.nodeInstance };
      const prepared = await gateway.execution.prepareObservation(entry.peer, { kind: 'lease.challenge', identity, payload }, options);
      await entry.native.recordChallengeSend(entry.native.gateId, prepared.envelope);
      const sent = await gateway.execution.sendPrepared(entry.peer, prepared.preparationId, options);
      if (!same(sent.envelope, prepared.envelope) || sent.reply.kind !== 'lease.renewal') throw new Error('LEASE_REPLY');
      p.validateResponse(prepared.envelope, sent.reply);
      const lease = await entry.native.acceptLease(entry.native.gateId, sent.reply);
      await current();
      if (entry.fenced || entry.generation !== notice.generation) throw new Error('EXECUTION_FENCED');
      if (entry.released) return { renewed: true };
      const latest = gateway.port.readFreshProjection(projectionContext);
      if (!latest.allowed) throw new Error(latest.reason);
      const releaseProjection = p.validateProjection(latest.projection);
      if (releaseProjection.ledgerSeq !== projection.ledgerSeq) throw new Error('LEASE_PROJECTION_CHANGED');
      const released = await entry.native.release(entry.native.gateId, entry.started, entry.ack, releaseProjection, lease);
      entry.released = true; return released;
      })();
      entry.inFlight = task;
      task.finally(() => { if (entry.inFlight === task) entry.inFlight = null; }).catch(() => {});
      return task;
    },
    async updateSuspension(identity, observation, intent) {
      await current();
      const entry = executions.get(bindingKey(identity));
      if (!entry) throw new Error('UNKNOWN_EXECUTION');
      await entry.prepared;
      if (!same(identity, entry.identity)) throw new Error('EXECUTION_IDENTITY');
      await entry.suspension.tick(observation, intent);
      return entry.suspension.snapshot;
    },
    handleLocalExecution(peer, request, callOptions) {
      if (!active || !localRuns) throw new Error('NODE_NOT_STARTED');
      return localRuns.accept(peer, request, callOptions);
    },
  };
  return api;
}
module.exports = { createWindowsNode };
