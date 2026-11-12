'use strict';
const fs = require('node:fs');
const path = require('node:path');
const c = require('../../../core/schedContract.cjs');
const { temporary, initialize, ticket, heartbeat, write } = require('./support.cjs');
const DAY = 86400000;
const BASE = Date.parse('2026-09-12T00:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed);
    n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n; return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
const line = payload => JSON.stringify({ ...payload, sha256: c.contentHash(payload) }) + '\n';
function fixture(t) {
  const share = temporary(t), paths = initialize(share), ledger = path.join(paths.root, 'ledger');
  fs.mkdirSync(ledger);
  return { share, paths, ledger };
}
function append(ledger, events, day) {
  const file = path.join(ledger, `${day}.jsonl`), bytes = events.map(line).join('');
  fs.appendFileSync(file, bytes); return Buffer.byteLength(bytes);
}
function records() {
  return Array.from({ length: 6 }, (_, i) => ticket(i + 1, { project: i % 2 ? 'demo-a' : 'demo-b', machine: 'machine-a' }));
}
function stream(seed, count = 180) {
  const random = rng(seed), tickets = records(), events = [];
  const add = (type, id, offset, data = {}, attemptId = 'a1') => events.push({ v: 1, seq: events.length + 1,
    at: iso(BASE + offset), type, ticketId: tickets[id].ticketId, attemptId, data });
  // Guaranteed adversarial prefix; random suffix and batch boundaries vary with the seed.
  add('submitted', 0, 0, { request: tickets[0].request });
  add('started', 0, 1000); add('started', 0, 2000); add('finished', 0, 4000);
  add('submitted', 0, DAY * 5, { request: { ...tickets[0].request, category: 'other', work: { type: 'build' } } });
  add('granted', 0, 4500, { permit: { ciAware: true } });
  add('started', 0, 5000); add('finished', 0, 7000);
  add('granted', 0, 7500, { permit: { ciAware: false } });
  add('started', 0, 8000); add('finished', 0, 9000);
  add('granted', 0, 9500, {}); add('started', 0, 11000); add('finished', 0, 10000);
  add('finished', 0, 12000);
  add('started', 1, 1000); add('finished', 1, 6000);
  add('started', 5, 1000); add('finished', 5, 7000);
  add('dispatch-intent', 0, 1000, { intent: { machine: 'machine-a', submissionId: 'job-a' } });
  add('dispatched', 0, 2000, { submissionId: 'job-a' });
  add('dispatch-intent', 0, 3000, { intent: { machine: 'machine-b', submissionId: 'job-b' } });
  while (events.length < count) {
    const id = Math.floor(random() * 6), kind = Math.floor(random() * 7), offset = Math.floor(random() * DAY * 6);
    if (kind === 0 && id !== 1 && id !== 5) add('submitted', id, offset, { request: { ...tickets[id].request,
      category: random() < .5 ? 'other' : 'unit-test', work: { type: random() < .5 ? 'test' : 'build' } } });
    else if (kind === 1) add('granted', id, offset, { permit: random() < .3 ? {} : { ciAware: random() < .5 } });
    else add(kind % 2 ? 'started' : 'finished', id, offset);
  }
  return { tickets, events, random };
}
module.exports = { fs, path, c, DAY, BASE, iso, rng, line, fixture, append, records, stream, heartbeat, write };
