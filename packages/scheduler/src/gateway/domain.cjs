'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const p = require('../protocol/contract.cjs');
const { failure } = require('../transport/framed.cjs');

/** Original domain modules resolve to .js in the public build, or the repository's TS loader in source tests. */
function validateDomain(bytes, entry, validationRoot) {
  if (['artifact-zip', 'log-segment', 'snapshot-bundle'].includes(entry.kind)) return Buffer.from(bytes);
  const c = require('../sched/sched-contract');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (entry.kind === 'project-trunk-head') {
    const value = raw.trim(); if (!/^[0-9a-f]{40}$/.test(value)) throw failure('TRUNK_HEAD'); return value;
  }
  let value;
  if (entry.kind === 'ledger-segment') {
    if (!raw.endsWith('\n')) throw failure('LEDGER_INCOMPLETE');
    value = raw.slice(0, -1).split('\n').map(line => JSON.parse(line));
    if (value.length !== entry.throughSeq - entry.fromSeq + 1) throw failure('LEDGER_RANGE');
    value.forEach((event, i) => {
      c.validateLedgerEvent(event); require('../sched/sched-ledger').assertLedgerChecksum(event);
      if (event.seq !== entry.fromSeq + i) throw failure('LEDGER_SEQUENCE');
    });
    return value;
  }
  value = JSON.parse(raw);
  switch (entry.kind) {
    case 'ticket-index': case 'command-receipt-index': case 'ledger-index': case 'execution-index':
      p.validateObjectDirectory(value);
      if (value.snapshotId !== entry.snapshotId || p.canonicalJson(value.ledgerCursor) !== p.canonicalJson(entry.ledgerCursor)) throw failure('DIRECTORY_VERSION');
      break;
    case 'ticket': {
      // The original snapshot parser is intentionally private. Feed its public read API an isolated,
      // protected validation directory; never call a writer or read the former shared authority.
      c.ticketId(entry.ticketId);
      const staging = fs.mkdtempSync(path.join(validationRoot, 'ticket-'));
      const directory = path.join(staging, 'sched', 'tickets');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${entry.ticketId}.json`);
      try {
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        const result = require('../sched/sched-tickets').readTicketSnapshot(staging, entry.ticketId);
        if (result.status !== 'ok' || !result.value) throw failure('TICKET_DOMAIN');
        value = result.value;
        for (const attempt of value.attempts) if (attempt.permit) {
          // This invokes the domain's private permit validator through its existing public event validator.
          c.validateEventDraft({ at: attempt.permit.issuedAt, type: 'granted', ticketId: value.ticketId,
            attemptId: attempt.attemptId, data: { permit: attempt.permit } });
          if (attempt.permit.ticketId !== value.ticketId || attempt.permit.attemptId !== attempt.attemptId ||
              attempt.permit.category !== value.request.category) throw failure('PERMIT_BINDING');
        }
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      break;
    }
    case 'scheduler-format': c.assertWritableFormat(value); break;
    case 'dispatcher-config': c.fields(value, { machine: c.segment, createdAt: c.isoTime, createdBy: c.text }); break;
    case 'dispatcher-heartbeat': c.validateDispatcherHeartbeat(value); break;
    case 'command-receipt': c.validateCommandReceipt(value); if (value.commandId !== entry.commandId) throw failure('RECEIPT_IDENTITY'); break;
    case 'hub-switch': {
      let warning = null;
      require('../sched/sched-hub-switch-reader').createHubSwitchReader({ share: validationRoot, readFile: () => raw, warn: text => { warning = text; } }).read();
      if (warning) throw failure('HUB_SWITCH_DOMAIN'); break;
    }
    case 'ci-policy': require('../sched/sched-ci-policy').parseCiPolicy(raw); break;
    case 'memory-floor':
      if (entry.view === 'config') require('../sched/sched-memory-floor').parseMemoryFloorConfig(raw);
      else {
        c.fields(value, { formatVersion: c.oneOf([1]), at: c.isoTime, machines: machines => {
          record(machines); for (const [name, machine] of Object.entries(machines)) {
            c.segment(name); c.fields(machine, { mode: c.oneOf(['open', 'single', 'blocked']), reason: c.text,
              freeMb: c.integer, totalMb: c.integer, floorMb: c.integer, sampledAt: c.isoTime }, { tightMb: c.integer });
          }
        } });
      }
      break;
    case 'managed-overuse':
      c.fields(value, { formatVersion: c.oneOf([1]), at: c.isoTime, tickets: c.list(item => {
        c.ticketId(item.ticketId); const { ticketId, ...overuse } = item; c.validateTicketOveruse(overuse);
      }) }); break;
    case 'snapshot-metadata': p.validateRequest('snapshot.metadata', value); bindAttempt(value, entry); break;
    case 'job-result': {
      const { suspension, ...result } = value; p.validateJobResult(result);
      if (suspension !== undefined) {
        record(suspension); bindAttempt(suspension, entry);
        c.validateSuspensionObservation(require('../sched/sched-suspend-store').recordObservation(suspension));
        c.segment(suspension.machine); c.text(suspension.token); c.integer(suspension.ownerPid, 1);
        if (suspension.schema !== 1) throw failure('SUSPENSION_SCHEMA');
      }
      break;
    }
    case 'artifact-manifest':
      c.fields(value, { schema: c.oneOf([1]), ticketId: c.ticketId, attemptId: c.attemptId, machine: c.segment,
        state: c.oneOf(['none', 'zipped', 'listed', 'failed']), totalBytes: c.integer,
        files: c.list(item => c.fields(item, { path: safeRelative, bytes: c.integer })),
        rejected: c.list(item => c.fields(item, { path: c.text, why: c.text })), createdAt: c.isoTime },
      { zip: safeRelative, zipBytes: c.integer, truncated: c.oneOf([true]), detail: c.text }); bindAttempt(value, entry); break;
    case 'log-descriptor':
      c.fields(value, { schema: c.oneOf([1]), ticketId: c.ticketId, attemptId: c.attemptId, snapshotId: c.text,
        ledgerCursor: cursor => { if (p.canonicalJson(cursor) !== p.canonicalJson(entry.ledgerCursor)) throw failure('LOG_CURSOR'); },
        encoding: c.oneOf(['utf-8']), totalBytes: c.integer, segments: segments => {
          p.validateObjectDirectory({ schema: 1, snapshotId: value.snapshotId, ledgerCursor: value.ledgerCursor, entries: segments, nextPageToken: value.nextPageToken });
          if (segments.some(segment => segment.kind !== 'log-segment' || segment.ticketId !== entry.ticketId || segment.attemptId !== entry.attemptId)) throw failure('LOG_SEGMENTS');
        }, nextPageToken: token => { if (token !== null) c.text(token); } });
      bindAttempt(value, entry); if (value.snapshotId !== entry.snapshotId) throw failure('LOG_SNAPSHOT'); break;
    case 'usage-history':
      c.fields(value, { formatVersion: c.oneOf([1]), groups: groups => {
        record(groups);
        for (const [key, entries] of Object.entries(groups)) {
          if (!key || key.length > 120 || !Array.isArray(entries) || entries.length > 20) throw failure('USAGE_GROUP');
          for (const item of entries) {
            const cores = number => { if (!Number.isFinite(number) || number < 0) throw failure('USAGE_CORES'); };
            c.fields(item, { at: c.isoTime, ticketId: c.ticketId, project: c.text, workType: c.text, usageKey: c.text,
              grantedCores: c.integer, requestedCores: c.integer, runningMs: c.integer, peakCores: cores, p90Cores: cores, samples: c.integer });
            if (item.usageKey !== key || item.project !== entry.project || item.p90Cores > item.peakCores) throw failure('USAGE_IDENTITY');
          }
        }
      } }); break;
    default: throw failure('DOMAIN_KIND');
  }
  return value;
}
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('DOMAIN_OBJECT'); }
function bindAttempt(value, entry) { if (value.ticketId !== entry.ticketId || value.attemptId !== entry.attemptId) throw failure('OBJECT_EXECUTION_IDENTITY'); }
function safeRelative(value) { if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw failure('OBJECT_PATH'); }
module.exports = { validateDomain };
