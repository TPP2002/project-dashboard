'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');
const WEEK = 7 * 86400000;
const MAX_RECEIPTS = 20000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sequence = v => Number.isSafeInteger(v) && v >= 0;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function validateProjectId(id) {
  // Same nonempty/128-character project identifier contract as taskOperation;
  // additionally require one portable filename component for the receipt file.
  if (typeof id !== 'string' || !id || id.length > 128 || /[\\/:*?"<>|\x00-\x1f]/.test(id)
      || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) fail(400, 'Invalid project');
  return id;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function opDigest(op) {
  const content = Object.fromEntries(Object.entries(op).filter(([key]) => key !== 'seq'));
  return crypto.createHash('sha256').update(canonical(content)).digest('hex');
}
function validLedger(ledger) {
  return object(ledger) && ledger.v === 1 && object(ledger.receipts) && object(ledger.acks)
    && Object.values(ledger.acks).every(sequence)
    && Object.values(ledger.receipts).every(r => object(r) && typeof r.deviceId === 'string' && r.deviceId
      && sequence(r.seq) && r.seq > 0 && /^[a-f0-9]{64}$/.test(r.digest)
      && ['applied', 'rejected'].includes(r.status) && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at))
      && (r.status !== 'rejected' || (typeof r.error === 'string' && Number.isInteger(r.httpStatus))));
}
/** Mutates only acknowledged receipts. Never discard an unacknowledged result. */
function pruneReceipts(ledger, now = Date.now(), reserve = 0) {
  const acknowledged = r => Object.hasOwn(ledger.acks, r.deviceId) && r.seq <= ledger.acks[r.deviceId];
  for (const [id, r] of Object.entries(ledger.receipts)) {
    if (acknowledged(r) && now - Date.parse(r.at) > WEEK) delete ledger.receipts[id];
  }
  let excess = Object.keys(ledger.receipts).length + reserve - MAX_RECEIPTS;
  if (excess > 0) {
    const candidates = Object.entries(ledger.receipts).filter(([, r]) => acknowledged(r))
      .sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
    for (const [id] of candidates) { if (excess-- <= 0) break; delete ledger.receipts[id]; }
  }
  return ledger;
}
function withLedger(home, projectId, fn) {
  const file = path.join(home, 'sync-ledger', validateProjectId(projectId) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file + '.lock', () => {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') ledger = { v: 1, receipts: {}, acks: {} };
      else fail(503, '同步回执账不可读，请恢复后重试');
    }
    if (!validLedger(ledger)) fail(503, '同步回执账损坏，请恢复后重试');
    const save = () => { pruneReceipts(ledger); atomicWriteJsonSync(file, ledger); };
    return fn(ledger, save);
  });
}
module.exports = { opDigest, pruneReceipts, withLedger, validateProjectId, MAX_RECEIPTS };
