'use strict';
const p = require('../../src/protocol/contract.cjs');
const f = require('./messages.cjs');
const ticketId = `tk-${p.contentHash([f.residentSubmission.project, f.residentSubmission.idempotencyKey]).slice(0, 20)}`;
const identity = { ...f.resident, ticketId };
const projection = { ...f.payloads['state.snapshot'], attempts: [{ ...f.granted, ticketId,
  state: 'granted', grantedCores: 2, permitLedgerSeq: 9, cancelRequested: false }] };
module.exports = [
  f.envelope('submission', { messageId: 'synthetic-hold-submit', sequence: 2, payload: f.residentSubmission }),
  f.envelope('state.snapshot', { messageId: 'synthetic-hold-grant', sequence: 2, payload: projection }),
  f.envelope('resident.renewal', { messageId: 'synthetic-hold-renew', sequence: 3, execution: identity,
    payload: { ...f.payloads['resident.renewal'], ticketId } }),
];
