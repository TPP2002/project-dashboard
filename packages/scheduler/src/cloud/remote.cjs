'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const p = require('../protocol/contract.cjs');
const load = require('./domain.cjs');
const { failure } = require('./storage.cjs');

function createRemote({ dataRoot, authority, store, facts, nodeFor, now, state, objects }) {
  const c = load('sched-contract'), jobs = load('sched-cluster-job'), handoff = load('sched-handoff');
  const snapshotGate = load('sched-snapshot-gate'), reclaim = load('sched-reclaim');
  const auto = load('sched-auto-handoff');
  const tasks = new Map(), replies = new Map();
  const waiting = load('sched-waiting').createWaitingTracker();
  const currentAttempt = ticket => ticket.attempts.find(a => a.attemptId === ticket.currentAttemptId);
  const granted = ticket => { const a = currentAttempt(ticket); return { stage: 'granted', ticketId: ticket.ticketId,
    attemptId: a.attemptId, permitToken: a.permit.token }; };
  const started = ticket => ({ ...granted(ticket), stage: 'started', controller: {
    pid: currentAttempt(ticket).controller.pid, creationFileTime: currentAttempt(ticket).controller.creationFileTime } });
  const accepted = plan => !!plan && (replies.get(plan.key)?.accepted === true || store.get('plan-results', plan.key)?.status === 'business_accepted');
  function schedule(machine, kind, execution, payload, discriminator = '') {
    const nodeId = nodeFor(machine);
    if (!nodeId) return null;
    const key = p.contentHash([kind, execution, machine, discriminator]);
    let plan = store.get('plans', key);
    if (!plan) {
      plan = { key, nodeId, kind, execution, payload: { ...payload, requestId: randomUUID(), timeoutMs: 10000 } };
      p.validateRequest(kind, plan.payload);
      store.put('plans', key, plan);
    }
    if (!p.IMMUTABLE_KINDS.includes(kind) || !accepted(plan)) {
      if (tasks.size >= 256 && !tasks.has(key)) throw failure('IO_FAILURE', 'remote intent capacity reached');
      tasks.set(key, plan);
    }
    return plan;
  }
  function observation(plan) { return plan ? facts.get(plan.payload.requestId) : null; }
  function source(envelope) {
    const request = envelope.payload;
    const ticketId = c.deriveTicketId(request.project, request.idempotencyKey);
    const identity = { stage: 'submission', ticketId, project: request.project, submissionHash: p.contentHash(request) };
    const principal = authority.principals.find(x => x.nodeIds.includes(envelope.nodeId));
    const machine = request.origin ?? principal?.readAccess?.machine ?? (principal?.machines.length === 1 ? principal.machines[0] : null);
    if (!machine) throw failure('NOT_CONFIGURED', 'submission source machine is ambiguous');
    const plan = schedule(machine, 'origin.request', identity, { machine, project: request.project, codeRef: request.codeRef });
    const proof = observation(plan);
    if (!proof || proof.kind !== 'origin.proof') return null;
    if (proof.payload.verdict === 'unknown') return null;
    return proof;
  }
  function publication(ticket, intent, observing = false) {
    const lifecycle = facts.lifecycle(intent.machine);
    if (!lifecycle) return null;
    const gate = jobs.payloadProtocolGate(auto.agentProtocolsFrom(facts.readMachines()), intent.machine);
    const publication = jobs.handoffPublication(dataRoot, ticket, intent, observing ? undefined : gate);
    // buildLifecycleIdentity is pure; no jobs directory is created or read.
    const modulePath = path.join(__dirname, '..', 'bot', 'cluster-lifecycle');
    const fs = require('node:fs');
    const { buildLifecycleIdentity } = require(fs.existsSync(`${modulePath}.js`) ? `${modulePath}.js` : `${modulePath}.ts`);
    const expected = buildLifecycleIdentity({ ...publication, epoch: lifecycle.epoch });
    const full = jobs.handoffPublication(dataRoot, ticket, intent);
    const fullIdentity = buildLifecycleIdentity({ ...full, epoch: lifecycle.epoch });
    const legacy = jobs.legacyHandoffIdentities(full, lifecycle.epoch);
    const known = [fullIdentity, ...legacy].filter(x => p.canonicalJson(x) !== p.canonicalJson(expected));
    const a = currentAttempt(ticket);
    const ready = store.get('snapshot', [ticket.ticketId, a.attemptId]);
    const payload = { submissionId: intent.submissionId, ownerMachine: intent.machine, authorityHost: authority.host,
      intentId: p.contentHash(intent), lifecycleEpoch: lifecycle.epoch, expected, codeRef: intent.codeRef,
      snapshot: ready?.state === 'ready' ? ready : null, grantedCores: a.permit.grantedCores,
      createdAt: intent.createdAt, submission: ticket.request, permit: a.permit,
      ...(publication.payload.queueRank ? { queueRank: publication.payload.queueRank } : {}),
      ...(publication.payload.rerun ? { rerun: publication.payload.rerun } : {}) };
    return { payload, known };
  }
  function stopPlan(ticket, action, reason) {
    const a = currentAttempt(ticket);
    if (!a?.controller?.creationFileTime || !a.permit) return null;
    if (action === 'stop' && !store.get('stop-intents', [ticket.ticketId, a.attemptId])) {
      store.put('stop-intents', [ticket.ticketId, a.attemptId], { execution: started(ticket), reason, createdAt: now() });
    }
    return schedule(a.permit.machine, 'process.stop-request', started(ticket), { machine: a.permit.machine, action, reason }, action);
  }
  function exited(ticket) {
    const a = currentAttempt(ticket);
    if (!a?.controller?.creationFileTime) return false;
    for (const action of ['stop', 'observe']) {
      const key = p.contentHash(['process.stop-request', started(ticket), a.permit.machine, action]);
      const proof = observation(store.get('plans', key));
      if (proof?.kind === 'process.stop-proof' && proof.payload.verdict === 'tree-exited') return true;
    }
    return false;
  }
  const io = {
    observe(ticket, intent) {
      const pub = publication(ticket, intent, true);
      if (!pub) return { kind: 'unknown' };
      const { expected, submissionId, ownerMachine, authorityHost, intentId, lifecycleEpoch } = pub.payload;
      const plan = schedule(intent.machine, 'handoff.observe-request', granted(ticket),
        { expected, submissionId, ownerMachine, authorityHost, intentId, lifecycleEpoch, legacyIdentities: pub.known });
      const reply = observation(plan);
      if (!reply || reply.kind !== 'handoff.observe' || reply.payload.state === 'unknown') return { kind: 'unknown' };
      const seen = reply.payload;
      if (['absent', 'claim', 'transition'].includes(seen.state)) {
        return { kind: seen.state === 'claim' ? 'claim-only' : seen.state, identity: seen.identity };
      }
      if (['done', 'failed', 'quarantine'].includes(seen.state)) {
        if (!seen.result) return { kind: 'unknown' };
        if (currentAttempt(ticket).controller && (ticket.cancelRequested || seen.result.reason === '执行机重启')) {
          stopPlan(ticket, 'observe', '核验作业终态对应的原生进程树');
          if (!exited(ticket)) return { kind: 'unknown' };
        }
        objects.registerObservation(ticket, reply);
      }
      // This is a read-only authenticated lifecycle record, not a fabricated owner.
      return { kind: 'record', identity: seen.identity,
        record: { ...seen.identity, state: seen.state, result: seen.result, metadata: {} } };
    },
    publish(ticket, intent) {
      const pub = publication(ticket, intent);
      if (!pub) return false;
      const planned = schedule(intent.machine, 'handoff.intent', granted(ticket), pub.payload);
      if (!accepted(planned)) return false;
      const plan = schedule(intent.machine, 'handoff.publish', granted(ticket), pub.payload);
      return accepted(plan);
    },
    quarantine(ticket, reason) {
      const a = currentAttempt(ticket), pub = publication(ticket, a.intent);
      if (!pub) return;
      const { expected, submissionId, ownerMachine, authorityHost, intentId, lifecycleEpoch } = pub.payload;
      schedule(a.permit.machine, 'handoff.quarantine', granted(ticket),
        { expected, submissionId, ownerMachine, authorityHost, intentId, lifecycleEpoch, reason, createdAt: now() }, reason);
    },
    prepareExited(ticket) {
      stopPlan(ticket, 'stop', '跨机准备超时'); return exited(ticket);
    },
  };
  const originProbe = {
    request() {}, pump() {}, inFlight() { return 0; }, close() {},
    take() {
      return Object.values(state().tickets).filter(t => t.request.execution === 'auto' && !t.placement).flatMap(t => {
        const saved = store.get('sources', t.ticketId);
        return saved ? [{ ticketId: t.ticketId, attemptId: t.currentAttemptId, verdict: 'owner',
          ownerSid: saved.observedOwnerSid, trusted: true }] : [];
      });
    },
  };
  return {
    source, exited, stopPlan, originProbe,
    readMachines: facts.readMachines, readBeats: facts.readBeats,
    reclaim(context) {
      facts.prune(new Set(Object.values(context.state().tickets).filter(t => t.endedAt === null).map(t => t.ticketId)));
      waiting.reclaim({ ...context, share: dataRoot, tickets: Object.values(context.state().tickets), remote: {
        read: facts.waiting, remove: facts.removeWaiting,
        grantedStale(ticket, reason) {
          if (!ticket.cancelRequested) context.append({ at: context.at, type: 'cancel-requested', ticketId: ticket.ticketId,
            attemptId: ticket.currentAttemptId, data: { reason } });
        },
      } });
      for (const ticket of Object.values(context.state().tickets)) {
        if (ticket.endedAt !== null || ticket.registerOnly || ticket.request.resident) continue;
        const a = currentAttempt(ticket);
        if (ticket.pendingQueue && a.result && reclaim.DISPATCHER_RECLAIM_REASONS.includes(a.result.reason)) {
          if (ticket.cancelRequested) load('sched-commands').finishQueuedTicket(context.append, ticket, context.at, a.result.reason);
          else context.append({ at: context.at, type: 'requeued', ticketId: ticket.ticketId, attemptId: a.attemptId,
            data: { nextAttemptId: c.nextAttemptId(a.attemptId), reason: '控制端死亡，原执行树已终止', atHead: true } });
          continue;
        }
        if (!a?.controller?.creationFileTime || !a.permit || !['running', 'paused', 'slow'].includes(ticket.state)) continue;
        const beat = facts.execution(ticket.ticketId);
        const limit = ticket.request.execution === 'auto' ? load('sched-daemon').autoJobHardTimeoutLimit(ticket) : c.jobHardTimeoutMs(ticket.request.work.type);
        const elapsed = load('sched-suspend-timing').measureSuspensionWindow(Date.parse(a.startedAt), Date.parse(context.at),
          { intervals: a.suspension?.intervals ?? [], slowIntervals: a.suspension?.slowIntervals ?? [] }).elapsedMs;
        const timedOut = limit !== undefined && elapsed >= limit;
        const lost = !beat && Date.parse(context.at) - Date.parse(a.startedAt) > c.ATTEMPT_RECLAIM_AFTER_MS;
        if (!ticket.cancelRequested && !timedOut && !lost) continue;
        if (timedOut && !ticket.cancelRequested) context.append({ at: context.at, type: 'cancel-requested', ticketId: ticket.ticketId,
          attemptId: a.attemptId, data: { reason: `硬超时:${ticket.request.work.type}` } });
        stopPlan(ticket, 'stop', timedOut ? '硬超时' : ticket.cancelRequested ? '请求撤单' : reclaim.DISPATCHER_RECLAIM_REASONS[0]);
        if (!exited(ticket)) continue;
        const managed = beat?.payload.suspend !== undefined || a.suspension !== undefined;
        const cancelled = context.state().tickets[ticket.ticketId].cancelRequested;
        context.append({ at: context.at, type: 'finished', ticketId: ticket.ticketId, attemptId: a.attemptId,
          data: { result: cancelled ? 'cancelled' : 'failed', terminal: cancelled || !managed,
            reason: reclaim.DISPATCHER_RECLAIM_REASONS[0] } });
        if (managed && !cancelled) context.append({ at: context.at, type: 'requeued', ticketId: ticket.ticketId, attemptId: a.attemptId,
          data: { nextAttemptId: c.nextAttemptId(a.attemptId), reason: '控制端死亡，原执行树已终止', atHead: true } });
      }
    },
    snapshot(context) {
      const readyByPath = new Map(), sizes = new Map();
      for (const ticket of Object.values(context.state().tickets)) {
        const a = currentAttempt(ticket);
        if (ticket.request.execution !== 'auto' || ticket.state !== 'granted' || !a.permit || a.permit.machine === ticket.request.origin) continue;
        let metadata = store.get('snapshot', [ticket.ticketId, a.attemptId]);
        if (!metadata) schedule(ticket.request.origin, 'snapshot.request', granted(ticket),
          { machine: ticket.request.origin, project: ticket.request.project, codeRef: ticket.request.codeRef });
        if (metadata) {
          const { requestId, object, ...manifest } = metadata;
          readyByPath.set(c.snapshotManifestPath(dataRoot, ticket.ticketId, a.attemptId), p.canonicalJson(manifest));
          if (metadata.state === 'ready') {
            try { sizes.set(path.join(c.snapshotDir(dataRoot), metadata.bundle), objects.snapshotSize(ticket)); }
            catch (error) { if (error.code !== 'DISCONNECTED') throw error; }
          }
        }
      }
      const readManifest = file => { if (!readyByPath.has(file)) throw failure('DISCONNECTED', 'snapshot unknown'); return readyByPath.get(file); };
      const statBundle = file => { if (!sizes.has(file)) throw failure('DISCONNECTED', 'snapshot unknown'); return sizes.get(file); };
      snapshotGate.applySnapshotGate({ ...context, share: dataRoot, logged: new Set(), readManifest, statBundle });
    },
    handoff(context) {
      handoff.handoffClusterTickets({ ...context, remote: true, remoteIo: io,
        autoPreflightIo: {
          readManifest(file) {
            const name = path.basename(file, '.json'), cut = name.lastIndexOf('--');
            const metadata = store.get('snapshot', [name.slice(0, cut), name.slice(cut + 2)]);
            if (!metadata) throw failure('DISCONNECTED', 'snapshot unknown');
            const { requestId, object, ...manifest } = metadata; return p.canonicalJson(manifest);
          },
          lstatBundle(file) {
            const ticket = state().tickets[path.basename(file, '.bundle')];
            const metadata = ticket && store.get('snapshot', [ticket.ticketId, ticket.currentAttemptId]);
            if (metadata?.state !== 'ready') throw failure('DISCONNECTED', 'snapshot unknown');
            return { isFile: () => true, size: objects.snapshotSize(ticket) };
          },
        } });
    },
    async pump(issue) {
      const active = new Set(Object.values(state().tickets).filter(t => t.endedAt === null).map(t => `${t.ticketId}/${t.currentAttemptId}`));
      for (const [key, value] of replies) if (!active.has(value.execution)) replies.delete(key);
      let count = 0;
      for (const [key, plan] of tasks) {
        if (plan.execution.stage !== 'submission' && !active.has(`${plan.execution.ticketId}/${plan.execution.attemptId}`)) {
          tasks.delete(key); replies.delete(key); continue;
        }
        if (++count > 32) break;
        try {
          const reply = await issue(plan);
          if (replies.size >= 256 && !replies.has(key)) throw failure('IO_FAILURE', 'remote reply capacity reached');
          replies.set(key, { accepted: reply.kind === 'result' && p.isBusinessSuccess(reply.payload), execution: `${plan.execution.ticketId}/${plan.execution.attemptId}` });
        } catch (error) {
          replies.delete(key);
          if (!['TIMEOUT', 'DISCONNECTED', 'FENCED', 'NOT_CONFIGURED'].includes(error.code)) throw error;
        }
        // Rebuilt by the next commit from authoritative domain state. This
        // prevents stale intents from continuing after a cancellation/requeue.
        tasks.delete(key);
      }
    },
  };
}
module.exports = { createRemote };
