'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../protocol/contract.cjs');
const sources = require('./sources.cjs');
const deployment = require('../sched/client/deployment-config.cjs');
const legacy = require('../sched/client/sched.cjs');
const { bindingKey, contained } = require('./objects.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => p.canonicalJson(a) === p.canonicalJson(b);
const terminalState = value => ['passed', 'failed', 'cancelled', 'voided'].includes(value.state);
const empty = offset => ({ offset, nextOffset: offset, bytesBase64: '' });
const supervision = key => /^SCHED_|^UDQ_TIMING_OUT$|^UDQ_SELECTION$/i.test(key);

function createLocalExecutions({ config, gateway, node, reader, executions, current, ciObserver, lifecycle, dependencies }) {
  const runs = new Map(), pending = new Map(), root = path.join(config.stateRoot, 'local-runs');
  const options = { timeoutMs: config.timeoutMs ?? 12000 };
  let closed = false;
  async function persist(run) {
    const file = path.join(root, run.runId + '.json'), stage = `${file}.${randomUUID()}.tmp`;
    const value = { runId: run.runId, sid: run.sid, callId: run.callId, requestHash: run.requestHash,
      ticketId: run.ticketId, cancellations: run.cancellations ?? {},
      state: run.state, terminal: run.terminal, reason: run.reason ?? null, identity: run.identity ?? null, remote: run.remote === true };
    const fd = await fs.open(stage, 'wx');
    try { await fd.writeFile(p.canonicalJson(value)); await fd.sync(); } finally { await fd.close(); }
    await fs.rename(stage, file);
  }
  async function readStream(run, name, offset, length) {
    if (!run.identity) { if (offset !== 0) throw new Error('OUTPUT_OFFSET'); return empty(0); }
    const directory = run.remote ? path.join(config.stateRoot, 'remote-output', run.runId, 'combined')
      : path.join(config.stateRoot, 'attempts', run.identity.ticketId, run.identity.attemptId);
    let fd;
    try {
      fd = await fs.open(await contained(directory, `workload.${name}.log`), 'r');
      const stat = await fd.stat();
      if (offset > stat.size) throw new Error('OUTPUT_OFFSET');
      const bytes = Buffer.alloc(Math.min(length, stat.size - offset));
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, offset);
      return { offset, nextOffset: offset + bytesRead, bytesBase64: bytes.subarray(0, bytesRead).toString('base64') };
    } catch (error) { if (error.code === 'ENOENT' && offset === 0) return empty(offset); throw error; }
    finally { await fd?.close(); }
  }
  async function response(run, request = {}) {
    const stdoutOffset = request.stdoutOffset ?? 0, stderrOffset = request.stderrOffset ?? 0;
    const began = performance.now(), deadline = began + 1000;
    const budget = Math.min(request.maxBytes ?? 65536, 65536), end = began + Math.min(request.waitMs ?? 0, 1000);
    let stdout, stderr, lastReply;
    do {
      // Bind completion to the state known before reading the streams. A task
      // which finishes during the read must be drained again before terminal.
      const view = { state: run.state, terminal: run.terminal, reason: run.reason };
      // Reserve half for each stream so an endless stdout cannot starve stderr.
      let timeout;
      try {
        [stdout, stderr] = await Promise.race([Promise.all([
          readStream(run, 'stdout', stdoutOffset, Math.ceil(budget / 2)),
          readStream(run, 'stderr', stderrOffset, Math.ceil(budget / 2)),
        ]), new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error('OUTPUT_READ_TIMEOUT'),
          { code: 'OUTPUT_READ_TIMEOUT' })), Math.max(1, deadline - performance.now())); })]);
      } catch (error) {
        // A quiet long poll can exhaust its wait budget between two reads.
        // Return the last complete observation at the original offsets; never
        // turn this normal boundary into failure or invent a terminal result.
        if (error.code === 'OUTPUT_READ_TIMEOUT' && lastReply) return lastReply;
        throw error;
      } finally { clearTimeout(timeout); }
      const stderrBudget = budget - (stdout.nextOffset - stdoutOffset);
      if (stderr.nextOffset - stderrOffset > stderrBudget) {
        const bytes = Buffer.from(stderr.bytesBase64, 'base64').subarray(0, stderrBudget);
        stderr = { offset: stderrOffset, nextOffset: stderrOffset + bytes.length, bytesBase64: bytes.toString('base64') };
      }
      lastReply = p.validateLocalExecutionReply({ kind: 'execution', runId: run.runId, state: view.state,
        stdout, stderr, terminal: view.terminal, ...(view.reason ? { reason: view.reason } : {}) });
      if (stdout.nextOffset !== stdoutOffset || stderr.nextOffset !== stderrOffset || ['terminal', 'unknown'].includes(view.state)
        || performance.now() >= end) return lastReply;
      await pause(Math.min(25, Math.max(0, end - performance.now())));
    } while (true);
  }
  async function finish(run, result, entry) {
    p.validateJobResult(result);
    run.terminal = result; run.state = 'terminal';
    if (entry) entry.finished = true;
    await persist(run);
  }
  async function report(entry, result) {
    if (entry.fenced) throw new Error('FINISH_SCOPE_RETIRED');
    entry.finishObservation ??= { kind: 'report.finished', identity: entry.identity,
      payload: { phase: 'finished', ticketId: entry.identity.ticketId, attemptId: entry.identity.attemptId, token: entry.identity.permitToken,
        machine: config.machine, at: new Date().toISOString(), result: result.ok ? 'passed' : 'failed',
        reason: result.reason ?? `exitCode=${result.exitCode}` } };
    const reply = await gateway.execution.acceptObservation(await gateway.localExecutionPeer(), entry.finishObservation, options);
    if (p.validateResult(reply).status !== 'business_accepted') throw new Error('FINISH_NOT_ACCEPTED');
  }
  async function pack(entry, ticket, result) {
    const item = deployment.getDeploymentConfig().projects.find(x => x.id === ticket.request.project)?.menu
      .find(x => x.id === (ticket.request.menu?.item ?? ticket.request.work.type));
    if (!item?.artifacts?.length) return result;
    const manifest = await require('../bot/cluster-agent-artifacts.js').packArtifacts({ worktree: entry.command.cwd,
      declared: item.artifacts, share: config.lifecycleRoot, artifactRoot: config.artifactRoot,
      ticketId: ticket.ticketId, attemptId: entry.identity.attemptId, machine: config.machine });
    return { ...result, artifacts: { state: manifest.state, totalBytes: manifest.totalBytes, fileCount: manifest.files.length,
      ...(manifest.state !== 'none' ? { manifest: `${ticket.ticketId}--${entry.identity.attemptId}.json` } : {}),
      ...(manifest.zip ? { zip: manifest.zip, zipBytes: manifest.zipBytes } : {}), ...(manifest.detail ? { detail: manifest.detail } : {}) } };
  }
  async function execute(run, request, source, handoff) {
    let entry, ticket, identity, lastRenew = 0, lastBeat = -Infinity, began, initialGrant;
    const timing = require('../sched/sched-suspend-timing.js');
    const policy = require('../sched/sched-suspend-policy.js');
    let ciMemory = policy.emptyCiMemory(), ciDuringJob = { samples: 0, seenSamples: 0, maxWorkers: 0 };
    try {
      while (!closed) {
        await current(); ticket = await reader.ticket(request.submission.ticketId);
        if (!ticket || ticket.contentHash !== request.submission.submissionHash) throw new Error('TICKET_SOURCE_CHANGED');
        if (terminalState(ticket)) {
          if (handoff) throw new Error('executor-aborted');
          const attempt = ticket.attempts.find(x => x.attemptId === ticket.currentAttemptId);
          return finish(run, { ok: ticket.state === 'passed' && attempt?.result?.exitCode === 0,
            exitCode: attempt?.result?.exitCode ?? null, reason: attempt?.result?.reason ?? ticket.state });
        }
        if (ticket.registerOnly || ticket.request.resident) throw new Error('NON_EXECUTABLE_TICKET');
        const attempt = ticket.attempts.find(x => x.attemptId === ticket.currentAttemptId), permit = attempt?.permit;
        if (!handoff && permit && (attempt.intent || ticket.request.execution === 'cluster' || permit.machine !== config.machine && ticket.request.execution === 'auto')) {
          await followRemote(run, ticket, source); return;
        }
        if (ticket.state !== 'granted' || !permit || permit.machine !== config.machine) {
          await reader.waiting(ticket.ticketId, ticket.lastSeq); await pause(500); continue;
        }
        if (handoff && (permit.attemptId !== handoff.publication.permit.attemptId || permit.token !== handoff.publication.permit.token)) throw new Error('HANDOFF_PERMIT_REPLACED');
        if (ticket.cancelRequested) throw new Error('CANCELLED_BEFORE_START');
        initialGrant ??= performance.now();
        const ci = ciObserver.read(), now = timing.suspendClock();
        const observation = { state: ci.state, observedAt: Date.parse(ci.staleSince ?? ci.observedAt) };
        const admission = policy.ciAllowsAdmission(now, observation, ciMemory); ciMemory = admission.memory;
        const ciPolicy = (await reader.read([{ kind: 'ci-policy' }])).objects[0]?.value;
        if (!permit.ciAware && ciPolicy?.mode !== 'coexist' && !admission.allowed) {
          await reader.waiting(ticket.ticketId, ticket.lastSeq); await pause(500); continue;
        }
        const observed = handoff ? handoff.publication.codeRef : await sources.codeAt(source.cwd, source.request);
        if (!handoff && !same(observed, ticket.request.codeRef)) throw new Error('CODE_REF_MISMATCH');
        const env = Object.fromEntries(Object.entries(request.env).filter(([key]) => !supervision(key)));
        const resolved = handoff ? { ok: true, resolvedPath: handoff.command.executable }
          : legacy.resolveWindowsExecutable(request.command, request.args, { cwd: source.cwd, env });
        if (!resolved.ok) throw new Error(resolved.reason);
        let executable = resolved.resolvedPath;
        if (!executable && /^cmd(?:\.exe)?$/i.test(request.command)) executable = path.join(process.env.SystemRoot, 'System32/cmd.exe');
        if (!executable) executable = request.command;
        identity = { stage: 'granted', ticketId: ticket.ticketId, attemptId: permit.attemptId, permitToken: permit.token };
        const prepared = await node.prepareExecution({ identity, project: ticket.request.project, codeRef: observed,
          job: { ticketId: ticket.ticketId, grantedCores: permit.grantedCores, ciAware: permit.ciAware }, requestHash: run.requestHash,
          command: handoff?.command ?? { executable, args: legacy.managedExecutionArgs(request.command, request.args, { cwd: source.cwd, env }), cwd: source.cwd,
            env, item: { category: ticket.request.category, env: [] } },
          observeCi: () => { const value = ciObserver.read(); return { state: value.state, observedAt: Date.parse(value.staleSince ?? value.observedAt) }; },
          intent: { manual: ticket.manualPause === true, ownerHold: ticket.ownerHold === true, ciCoexist: ciPolicy?.mode === 'coexist' } });
        identity = prepared.identity; run.identity = identity; await persist(run);
        entry = executions.get(bindingKey(identity)); began = timing.suspendClock();
        break;
      }
      if (!entry) throw new Error('NODE_CLOSED_BEFORE_START');
      while (!closed) {
        const fact = await entry.native.poll(identity);
        if (fact.verdict === 'unknown') throw new Error('TREE_EXIT_UNKNOWN');
        if (fact.empty) {
          entry.exitFact = structuredClone(fact);
          let result = { ok: fact.exitCode === 0 && entry.released && !fact.expired, exitCode: fact.exitCode,
            reason: fact.reason ?? (fact.expired ? 'native lease expired' : `exitCode=${fact.exitCode}`), machine: config.machine,
            finishedAt: new Date().toISOString() };
          if (handoff && entry.released && !fact.expired && !entry.fenced) {
            const observed = JSON.parse(await fs.readFile(await contained(handoff.workspace.directory, 'workload-result.json'), 'utf8'));
            if (observed.exitCode === null && fact.exitCode === 3) result = { ...result, ok: false, exitCode: null, reason: 'workload exit code unknown' };
            if (observed.refused && fact.exitCode === 2) {
              if (!['runtime-mismatch', 'deps-timeout', 'deps-recipe-unsupported', 'deps-install-failed'].includes(observed.refused)) throw new Error('WORKLOAD_REFUSAL');
              result = { ...result, ok: false, refused: observed.refused, reason: observed.detail ?? observed.refused };
            }
          }
          if (ciDuringJob.seenSamples) result.ciDuringJob = ciDuringJob;
          if (!entry.released) result = { ok: false, exitCode: null, reason: result.reason,
            notStarted: { attemptId: identity.attemptId, state: 'granted', waitedMs: Math.round(performance.now() - initialGrant) } };
          else {
            const measured = timing.measureSuspensionWindow(began, timing.suspendClock(), entry.suspension.snapshot);
            Object.assign(result, { elapsedSec: Math.round(measured.elapsedMs / 1000), rawElapsedSec: measured.rawMs / 1000,
              suspendedMs: measured.suspendedMs, comparable: measured.comparable });
          }
          await entry.suspension.finish();
          if (handoff?.timing && result.exitCode !== null && result.exitCode !== 0 && !result.refused && !entry.fenced && !fact.expired)
            result.rerunPlan = await require('./rerun.cjs').collect(handoff.timing, entry.suspension.snapshot);
          if (result.exitCode !== null) result = await pack(entry, ticket, result);
          if (handoff) {
            // jobs-v12 remains the only result authority for published jobs.
            // Cloud reconciles it through handoff.observe, including rerunPlan.
            lifecycle.transition(handoff.publication, result.ok ? 'done' : 'failed', { ...result, suspension: entry.suspension.snapshot });
          } else if (entry.released && !entry.fenced) {
            // Retain one immutable finished observation until business acceptance.
            while (!closed) {
              try { await current(); await report(entry, result); break; }
              catch (error) { if (entry.fenced) break; run.reason = `finish pending:${error.message}`; await pause(500); }
            }
          }
          return finish(run, result, entry);
        }
        try {
          await current();
          if (entry.fenced) { await pause(100); continue; }
          if (!entry.released || performance.now() - lastRenew >= 10000) {
            await node.releaseExecution(identity); lastRenew = performance.now();
            run.state = 'running'; run.reason = undefined;
          }
          const latest = await reader.ticket(ticket.ticketId);
          if (!latest || latest.currentAttemptId !== identity.attemptId || latest.cancelRequested || terminalState(latest)) {
            await entry.native.fence(); run.reason = 'cancelled or execution replaced'; continue;
          }
          ticket = latest;
          const ci = ciObserver.read();
          ciDuringJob.samples++;
          if (ci.state === 'active') {
            ciDuringJob.seenSamples++; ciDuringJob.maxWorkers = Math.max(ciDuringJob.maxWorkers, ci.ciWorkers ?? 0);
            ciDuringJob.firstSeenAt ??= ci.observedAt; ciDuringJob.lastSeenAt = ci.observedAt;
          }
          const ciPolicy = (await reader.read([{ kind: 'ci-policy' }])).objects[0]?.value;
          await node.updateSuspension(identity, { state: ci.state, observedAt: Date.parse(ci.staleSince ?? ci.observedAt) },
            { manual: ticket.manualPause === true, ownerHold: ticket.ownerHold === true, ciCoexist: ciPolicy?.mode === 'coexist' });
          const c = require('../sched/sched-contract.js');
          const item = deployment.getDeploymentConfig().projects.find(x => x.id === ticket.request.project)?.menu.find(x => x.id === ticket.request.menu?.item);
          const cap = ticket.request.execution === 'auto' ? c.menuHardTimeoutMs(item) : c.jobHardTimeoutMs(ticket.request.work.type);
          if (cap && timing.measureSuspensionWindow(began, timing.suspendClock(), entry.suspension.snapshot).elapsedMs >= cap) {
            await reader.cancel(ticket.ticketId, { submitter: config.machine, reason: 'hard timeout' }); await entry.native.fence();
          }
          if (performance.now() - lastBeat >= 5000) {
            const suspend = require('../sched/sched-suspend-store.js').recordObservation(entry.suspension.snapshot);
            await gateway.execution.acceptObservation(await gateway.localExecutionPeer(), { kind: 'execution.heartbeat', identity,
              payload: { ticketId: identity.ticketId, attemptId: identity.attemptId, token: identity.permitToken,
                machine: config.machine, at: new Date().toISOString(),
                childPid: entry.root?.pid ?? entry.suspension.snapshot.root?.pid, suspend } }, options);
            lastBeat = performance.now();
          }
        } catch (error) { run.reason = error.message; /* Native deadline continues; no acknowledgement means no release. */ }
        await pause(250);
      }
    } catch (error) {
      if (entry?.native) {
        try { await entry.native.fence(); } catch { /* Unknown is retained below. */ }
        run.state = 'unknown'; run.reason = error.message; run.terminal = null; await persist(run);
      } else if (identity) {
        run.state = 'unknown'; run.reason = error.message; await persist(run);
      } else {
        const result = { ok: false, exitCode: 2, refused: handoff && /executor-aborted|CANCELLED_BEFORE_START|HANDOFF_PERMIT_REPLACED/.test(error.message)
          ? 'executor-aborted' : 'launch-refused', reason: error.message };
        if (handoff) lifecycle.transition(handoff.publication, 'failed', result);
        await finish(run, result);
      }
    }
  }
  async function followRemote(run, ticket, source) {
    run.remote = true;
    while (!closed) {
      const value = await reader.ticket(ticket.ticketId);
      if (!value) throw new Error('REMOTE_TICKET_UNKNOWN');
      run.state = ['running', 'paused', 'slow'].includes(value.state) ? 'running' : 'queued';
      if (value.currentAttemptId) {
        run.identity ??= { ticketId: value.ticketId, attemptId: value.currentAttemptId };
        const output = require('./output.cjs'), directory = path.join(config.stateRoot, 'remote-output', run.runId);
        try {
          await output.followLog(reader, value.ticketId, value.currentAttemptId, path.join(directory, value.currentAttemptId));
          await output.appendRemote(run, value.currentAttemptId, path.join(directory, value.currentAttemptId), path.join(directory, 'combined'),
            config.maxLogBytes ?? 64 * 1024 * 1024);
        }
        catch (error) { run.reason = `log pending:${error.message}`; }
      }
      if (terminalState(value)) {
        const result = (await reader.read([{ kind: 'job-result', ticketId: value.ticketId, attemptId: value.currentAttemptId }])).objects[0]?.value;
        if (!result) throw new Error('REMOTE_RESULT_UNKNOWN');
        if (result.artifacts?.manifest) {
          const downloaded = await require('./output.cjs').artifacts(reader, value, value.currentAttemptId, source.cwd);
          if (downloaded.state !== 'ready') run.reason = downloaded.reason;
        }
        const { suspension, ...body } = result;
        return finish(run, { ...body, exitCode: body.exitCode ?? null });
      }
      await pause(500);
    }
  }
  async function begin(peer, request) {
    const runId = p.contentHash([peer.sid, request.callId]), requestHash = p.contentHash(request);
    const prior = runs.get(runId);
    if (prior) { if (prior.requestHash !== requestHash) throw new Error('LOCAL_CALL_CONFLICT'); return response(prior); }
    await fs.mkdir(root, { recursive: true }); await contained(root, '.');
    const file = path.join(root, runId + '.json');
    const run = { runId, sid: peer.sid, callId: request.callId, requestHash, ticketId: request.submission.ticketId,
      cancellations: {}, state: 'queued', terminal: null };
    try {
      const fd = await fs.open(file, 'wx');
      try { await fd.writeFile(p.canonicalJson(run)); await fd.sync(); } finally { await fd.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(await contained(root, runId + '.json'), 'utf8'));
      if (previous.sid !== peer.sid || previous.requestHash !== requestHash) throw new Error('LOCAL_CALL_CONFLICT');
      const recovered = { ...previous, state: previous.state === 'terminal' ? 'terminal' : 'unknown',
        terminal: previous.state === 'terminal' ? previous.terminal : null, reason: 'previous node run; never restarted' };
      runs.set(runId, recovered); return response(recovered);
    }
    runs.set(runId, run);
    try {
      const source = await sources.original(gateway, request.submission, undefined, options);
      if (source.peer.sid !== peer.sid || source.source.observedOwnerSid !== peer.sid) throw new Error('RUN_OWNER');
      if (path.resolve(request.cwd).toLowerCase() !== source.cwd.toLowerCase()) throw new Error('RUN_WORKTREE');
      const project = deployment.getDeploymentConfig().projects.find(x => x.id === source.request.project);
      if (!project?.accepted || !project.machines.includes(config.machine)) throw new Error('RUN_PROJECT');
      void execute(run, request, source).catch(error => { run.state = 'unknown'; run.reason = error.message; });
    } catch (error) { await finish(run, { ok: false, exitCode: 2, refused: 'source-refused', reason: error.message }); }
    return response(run);
  }
  return {
    close() { closed = true; },
    async executeHandoff(publication, job, workspace) {
      await fs.mkdir(root, { recursive: true });
      const run = { runId: p.contentHash(['handoff', publication.submissionId, publication.permit.token]),
        sid: (await gateway.localExecutionPeer()).sid, callId: publication.intentId,
        requestHash: p.contentHash({ publication: { ...publication, requestId: null, timeoutMs: null }, job }),
        ticketId: publication.permit.ticketId, state: 'queued', terminal: null, cancellations: {} };
      const { commandFromCatalog, jobEnvironment } = require('./command.cjs');
      const menu = await commandFromCatalog({ project: publication.submission.project, job, machine: config.machine,
        codeRef: { kind: 'commit', value: workspace.commit }, share: config.lifecycleRoot, worktree: workspace.cwd, deferTools: true });
      const timing = await require('./rerun.cjs').prepare(menu, job, workspace.directory);
      const planFile = path.join(workspace.directory, 'workload.json');
      await fs.writeFile(planFile, JSON.stringify({ project: workspace.project, cwd: workspace.cwd, directory: workspace.directory,
        words: menu.words, env: menu.env }), { flag: 'wx' });
      const identity = { ticketId: publication.permit.ticketId, attemptId: publication.permit.attemptId, permitToken: publication.permit.token };
      const command = { executable: process.execPath, args: [require.resolve('./workload.cjs'), planFile], cwd: workspace.cwd,
        item: menu.item, env: jobEnvironment({ command: menu, directory: workspace.directory, identity, cores: publication.grantedCores }) };
      await persist(run);
      try {
        await execute(run, { submission: sources.submissionIdentity(publication.submission), command: command.executable, args: command.args, env: command.env },
          { cwd: workspace.cwd, request: publication.submission }, { publication, command, timing, workspace });
      } catch (error) { error.nativeMayExist = true; throw error; }
      return run;
    },
    async accept(peer, input, callOptions) {
      const request = p.validateLocalSemanticRequest(input);
      if (!/^S-1-[0-9-]+$/.test(peer?.sid ?? '') || !Number.isSafeInteger(peer.pid) || !peer.creationFileTime || !peer.logonSessionId) throw new Error('OS_PEER_REQUIRED');
      if (request.kind === 'local-run') {
        const key = p.contentHash([peer.sid, request.callId]), hash = p.contentHash(request);
        if (pending.has(key)) {
          if (pending.get(key).hash !== hash) throw new Error('LOCAL_CALL_CONFLICT');
          return pending.get(key).work;
        }
        const work = begin(peer, request); pending.set(key, { hash, work });
        try { return await work; } finally { pending.delete(key); }
      }
      if (!['local-run-read', 'local-run-cancel'].includes(request.kind)) throw new Error('LOCAL_EXECUTION_KIND');
      let run = runs.get(request.runId);
      if (!run) {
        if (!/^[a-f0-9]{64}$/.test(request.runId)) throw new Error('RUN_ID');
        const prior = JSON.parse(await fs.readFile(await contained(root, request.runId + '.json'), 'utf8'));
        run = { ...prior, state: prior.state === 'terminal' ? 'terminal' : 'unknown', terminal: prior.state === 'terminal' ? prior.terminal : null };
        runs.set(request.runId, run);
      }
      if (run.sid !== peer.sid) throw new Error('RUN_OWNER');
      if (request.kind === 'local-run-cancel') {
        if (!run.ticketId) throw new Error('RUN_IDENTITY_UNKNOWN');
        run.cancellations ??= {};
        if (!Object.hasOwn(run.cancellations, request.callId)) {
          run.cancellations[request.callId] = { commandId: `local-cancel-${request.callId}`, kind: 'cancel', data: { ticketId: run.ticketId, reason: 'local caller cancellation' },
            submitter: peer.sid, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
          await persist(run);
        }
        const command = run.cancellations[request.callId];
        const reply = await gateway.semantic.accept(peer, { kind: 'command', callId: request.callId, command }, callOptions);
        if (reply.kind !== 'business' || p.validateResult(reply.result).status !== 'business_accepted') throw new Error('CANCEL_UNKNOWN');
      }
      return response(run, request.kind === 'local-run-read' ? request : {});
    },
  };
}
module.exports = { createLocalExecutions, supervision };
