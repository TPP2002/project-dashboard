'use strict';
const fs = require('node:fs');
const path = require('node:path');
const load = require('./domain.cjs');
const { failure } = require('./storage.cjs');
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

// This is a byte-position index over the original authoritative ledger, never
// another ledger/projection. Each point read verifies the original checksum.
function createLedgerIndex({ dataRoot, store }) {
  const c = load('sched-contract'), ledger = load('sched-ledger');
  const root = c.schedPaths(dataRoot).ledger;
  function position(event) {
    const file = c.ledgerPath(dataRoot, c.ledgerRecordTime(event));
    const length = Buffer.byteLength(c.canonicalJson(event)) + 1;
    if (length > MAX_EVENT_BYTES) throw failure('IO_FAILURE', 'ledger event exceeds bounded index reader');
    const end = fs.statSync(file).size;
    return { file: path.basename(file), offset: end - length, length, sha256: event.sha256 };
  }
  function record(event) {
    const index = position(event);
    const prior = store.get('meta', 'ledger-index') ?? { seq: 0 };
    if (event.seq !== prior.seq + 1) throw failure('FENCED', 'ledger index sequence conflict');
    store.immutable('ledger-positions', event.seq, index);
    store.put('meta', 'ledger-index', { seq: event.seq, file: index.file, end: index.offset + index.length });
  }
  function read(seq, cutoff) {
    if (seq < 1 || seq > cutoff.seq) throw failure('FENCED', 'ledger range exceeds frozen cutoff');
    const index = store.get('ledger-positions', seq);
    if (!index || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(index.file) || !Number.isSafeInteger(index.offset)
      || index.offset < 0 || !Number.isSafeInteger(index.length) || index.length < 1 || index.length > MAX_EVENT_BYTES) throw failure('IO_FAILURE', 'ledger position unavailable');
    const fd = fs.openSync(path.join(root, index.file), 'r');
    const bytes = Buffer.alloc(index.length);
    try {
      let done = 0;
      while (done < bytes.length) {
        const count = fs.readSync(fd, bytes, done, bytes.length - done, index.offset + done);
        if (!count) throw failure('IO_FAILURE', 'ledger prefix shortened'); done += count;
      }
    } finally { fs.closeSync(fd); }
    const event = JSON.parse(bytes.toString('utf8')); ledger.assertLedgerChecksum(event);
    if (event.seq !== seq || event.sha256 !== index.sha256 || seq === cutoff.seq && event.sha256 !== cutoff.hash) throw failure('IO_FAILURE', 'ledger index identity mismatch');
    return event;
  }
  function recover(cutoff, commit) {
    let saved = store.get('meta', 'ledger-index') ?? { seq: 0 };
    if (saved.seq > cutoff.seq) throw failure('FENCED', 'ledger index ahead of authority');
    if (saved.seq === cutoff.seq) { if (saved.seq) read(saved.seq, cutoff); return; }
    // Only an unindexed tail is scanned; an imported ledger is indexed once.
    // Release the owner guard and renew between bounded batches.
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      commit(() => {
        for (const { event, index } of pending) store.immutable('ledger-positions', event.seq, index);
        const last = pending.at(-1);
        saved = { seq: last.event.seq, file: last.index.file, end: last.index.offset + last.index.length };
        store.put('meta', 'ledger-index', saved);
      });
      pending = [];
    };
    let next = saved.seq + 1;
    for (const name of fs.readdirSync(root).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
      if (saved.file && name < saved.file) continue;
      const fd = fs.openSync(path.join(root, name), 'r');
      let offset = name === saved.file ? saved.end : 0, lineStart = offset, carry = Buffer.alloc(0);
      try {
        while (next <= cutoff.seq) {
          const buf = Buffer.alloc(65536), count = fs.readSync(fd, buf, 0, buf.length, offset);
          if (!count) break;
          offset += count; carry = Buffer.concat([carry, buf.subarray(0, count)]);
          let end;
          while ((end = carry.indexOf(10)) >= 0 && next <= cutoff.seq) {
            const length = end + 1, line = carry.subarray(0, length);
            carry = carry.subarray(length);
            if (!line.toString('utf8').trim()) { lineStart += length; continue; }
            if (length > MAX_EVENT_BYTES) throw failure('IO_FAILURE', 'ledger event too large');
            const event = JSON.parse(line.toString('utf8')); ledger.assertLedgerChecksum(event);
            if (event.seq !== next++) throw failure('FENCED', 'ledger recovery sequence');
            pending.push({ event, index: { file: name, offset: lineStart, length, sha256: event.sha256 } });
            lineStart += length;
            if (pending.length === 128) flush();
          }
          if (carry.length > MAX_EVENT_BYTES) throw failure('IO_FAILURE', 'ledger event too large');
        }
        // The original ledger reader accepts a complete final JSON record with
        // no trailing newline. Preserve its exact prefix length in this index.
        if (next <= cutoff.seq && carry.length) {
          const event = JSON.parse(carry.toString('utf8')); ledger.assertLedgerChecksum(event);
          if (event.seq !== next++) throw failure('FENCED', 'ledger recovery sequence');
          pending.push({ event, index: { file: name, offset: lineStart, length: carry.length, sha256: event.sha256 } });
        }
      } finally { fs.closeSync(fd); }
      if (next > cutoff.seq) break;
    }
    flush();
    if (next !== cutoff.seq + 1) throw failure('FENCED', 'ledger cutoff missing');
    if (cutoff.seq) read(cutoff.seq, cutoff);
  }
  return { record, read, recover };
}
module.exports = { createLedgerIndex };
