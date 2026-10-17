'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const p = require('../protocol/contract.cjs');
const { bindingKey, contained } = require('./objects.cjs');
const { prepareWorkspace } = require('./workspace.cjs');
function refusalReason(error) {
  if (error.message.startsWith('MENU_ARGS:')) return 'menu-' + error.message.slice(10).split(':')[0];
  const fixed = { PROJECT_NOT_AUTHORIZED: 'menu-project-not-accepted', MENU_NOT_PORTABLE: 'menu-item-not-portable',
    MENU_RESTORE_TEMPLATE_MISSING: 'menu-no-restore-template', SNAPSHOT_BUNDLE_UNAVAILABLE: 'snapshot-missing',
    SNAPSHOT_BUNDLE_IDENTITY: 'snapshot-commit-mismatch', 'executor-aborted': 'executor-aborted' };
  if (fixed[error.message]) return fixed[error.message];
  const reason = error.message.split(':')[0];
  if (['snapshot-bundle-prerequisite-missing', 'snapshot-commit-mismatch', 'snapshot-git-failed', 'snapshot-timeout', 'snapshot-bad-ticket'].includes(reason)) return reason;
  return 'workspace-broken';
}
function createHandoffRunner({ config, lifecycle, reader, localRuns, current, onFault }) {
  const jobs = new Map(); let closed = false, working = 0;
  async function run(row) {
    const pub = row.publication, permit = pub.permit;
    const directory = path.join(config.stateRoot, 'handoffs');
    const key = bindingKey({ ticketId: permit.ticketId, attemptId: permit.attemptId, permitToken: permit.token });
    let picked = false;
    const abort = new AbortController(); let checking = false, checkError;
    row.abort = abort;
    const check = async () => {
      if (checking || abort.signal.aborted) return;
      checking = true;
      try {
        const notice = await current();
        if (notice.generation !== row.generation || p.canonicalJson(notice.scope) !== p.canonicalJson(row.scope)) throw new Error('PREPARATION_FENCED');
        const ticket = await reader.ticket(permit.ticketId), attempt = ticket?.attempts.find(x => x.attemptId === ticket.currentAttemptId);
        if (!ticket || ticket.cancelRequested || ticket.endedAt || attempt?.permit?.token !== permit.token
          || attempt.attemptId !== permit.attemptId || attempt.permit.machine !== config.machine) throw new Error('executor-aborted');
      } catch (error) { checkError = error; abort.abort(); } finally { checking = false; }
    };
    let timer;
    try {
      await fs.mkdir(directory, { recursive: true }); await contained(config.stateRoot, 'handoffs');
      // This durable claim precedes every side effect. A restart cannot replay an
      // uncertain preparation or launch, even if publication is delivered again.
      const fd = await fs.open(path.join(directory, key + '.claim'), 'wx');
      try { await fd.writeFile(p.canonicalJson(pub)); await fd.sync(); } finally { await fd.close(); }
      const observed = lifecycle.observe(pub);
      if (observed.state !== 'inbox' || !observed.record) throw new Error('HANDOFF_NOT_INBOX');
      const record = lifecycle.transition(pub, 'running'); picked = true;
      await check(); if (checkError) throw checkError;
      timer = setInterval(() => { void check(); }, 1000);
      const workspace = await prepareWorkspace({ config, publication: pub, reader, signal: abort.signal });
      await check(); if (checkError) throw checkError;
      if (closed || abort.signal.aborted) throw new Error('executor-aborted');
      clearInterval(timer);
      await localRuns.executeHandoff(pub, { ...record.payload, ticketId: permit.ticketId, jobId: pub.expected.jobId,
        codeVersion: record.codeVersion }, workspace);
    } catch (error) {
      row.reason = error.message; onFault(`HANDOFF:${error.message}`);
      if (picked && error.nativeMayExist !== true) {
        // Only pre-launch failures are archived here. The execution loop retains
        // unknown native trees itself and never throws them into a false exit.
        const result = { ok: false, exitCode: 2, refused: checkError ? 'executor-aborted' : refusalReason(error),
          reason: error.message, machine: config.machine, finishedAt: new Date().toISOString() };
        lifecycle.transition(pub, 'failed', result);
      }
    } finally { clearInterval(timer); row.done = true; working--; pump(); }
  }
  function pump() {
    if (closed) return;
    const pending = [...jobs.values()].sort((a, b) => (a.publication.queueRank?.band ?? 0) - (b.publication.queueRank?.band ?? 0)
      || (a.publication.queueRank?.queuedAt ?? a.publication.createdAt).localeCompare(b.publication.queueRank?.queuedAt ?? b.publication.createdAt));
    for (const row of pending) {
      if (working >= (config.maxJobs ?? 4)) break;
      if (row.started || row.done) continue;
      row.started = true; working++;
      row.work = run(row).catch(error => onFault(`HANDOFF_UNRESOLVED:${error.message}`));
    }
  }
  return {
    async accept(publication) {
      const permit = publication.permit, key = bindingKey({ ticketId: permit.ticketId, attemptId: permit.attemptId, permitToken: permit.token });
      const content = p.contentHash({ ...publication, requestId: null, timeoutMs: null });
      if (jobs.has(key)) { if (jobs.get(key).hash !== content) throw new Error('HANDOFF_CHANGED'); return; }
      const notice = await current();
      jobs.set(key, { publication, hash: content, generation: notice.generation, scope: notice.scope, queuedAt: Date.now(), started: false }); pump();
    },
    async close() {
      closed = true; for (const row of jobs.values()) row.abort?.abort();
      await Promise.all([...jobs.values()].map(row => row.work));
    },
  };
}
module.exports = { createHandoffRunner };
