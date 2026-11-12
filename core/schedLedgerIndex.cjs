'use strict';
/** Read-only incremental ledger projection. Raw events survive only beyond the folded prefix. */
const nativeFs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { createHash } = require('node:crypto');
const c = require('./schedContract.cjs');
const { sampleKey, SAMPLE_LIMIT } = require('./schedLedger.cjs');
const DAY = 86400000, WEEK = 7 * DAY;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyFor = event => JSON.stringify([event.ticketId, event.attemptId]);
const newest = (a, b) => b.ms - a.ms || b.seq - a.seq;
const requestOf = request => ({ project: request.project, category: request.category, work: { type: request.work.type } });

function validate(event, previousSeq) {
  c.requireRecord(event, '台账事件');
  c.oneOf([1])(event.v); c.integer(event.seq, 1); c.isoTime(event.at); c.text(event.type); c.requireRecord(event.data);
  if (event.ticketId !== undefined) { c.ticketId(event.ticketId); c.text(event.attemptId); }
  if (['started', 'finished', 'dispatch-intent', 'dispatched'].includes(event.type)) { c.ticketId(event.ticketId); c.text(event.attemptId); }
  if (event.type === 'dispatch-intent') {
    const intent = c.requireRecord(event.data.intent); c.segment(intent.machine); c.segment(intent.submissionId);
  }
  if (event.type === 'dispatched') c.segment(event.data.submissionId);
  if (event.type === 'submitted') {
    c.ticketId(event.ticketId);
    const request = c.requireRecord(event.data.request);
    c.text(request.project); c.text(request.category); c.text(c.requireRecord(request.work).type);
  }
  const { sha256, ...payload } = event;
  if (sha256 !== c.contentHash(payload) || event.seq <= previousSeq) throw new Error('台账校验和或事件顺序不合法');
}

function createLedgerIndex(options = {}) {
  const fs = options.fs ?? nativeFs;
  let share = null, files = [], initialized = false, readable = false, reason = null;
  let bytesRead = 0, fullRebuilds = 0;
  let pending, requests, submissions, handoffs, marks, starts, permits, samples, ids, requestPool;
  let durationCache, groupCache, freshIds, projectCache, maxEventAt;
  let previousSeq, foldedSeq, foldedAt, retainFrom, highNow, prunedThrough, oldMarkAdded;
  function clear() {
    pending = []; requests = new Map(); submissions = new Map(); handoffs = new Map(); marks = [];
    starts = new Map(); permits = new Map(); samples = new Map(); previousSeq = 0; foldedSeq = 0; foldedAt = -Infinity;
    ids = new Map(); requestPool = new Map(); durationCache = null; groupCache = null; freshIds = new Set(); projectCache = null; maxEventAt = -Infinity;
    retainFrom = -Infinity; highNow = -Infinity; prunedThrough = -Infinity; oldMarkAdded = false;
  }
  clear();
  const signatureEqual = (a, b) => a.name === b.name && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  function listing() {
    const directory = path.join(c.schedPaths(share).root, 'ledger');
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).map(entry => {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) throw new Error('台账目录含未知文件');
      c.isoTime(`${entry.name.slice(0, 10)}T00:00:00.000Z`);
      const stat = fs.statSync(path.join(directory, entry.name), { bigint: true });
      return { name: entry.name, size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
    });
  }
  function readRange(file, start, length) {
    const fd = fs.openSync(path.join(c.schedPaths(share).root, 'ledger', file.name), 'r');
    try {
      const buffer = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const count = fs.readSync(fd, buffer, offset, length - offset, start + offset);
        bytesRead += count;
        if (!count) throw new Error('台账读取期间发生变化');
        offset += count;
      }
      return buffer;
    } finally { fs.closeSync(fd); }
  }
  function accept(event) {
    previousSeq = event.seq;
    const at = Date.parse(event.at);
    maxEventAt = Math.max(maxEventAt, at);
    let id = event.ticketId;
    if (groupCache && id) {
      if (!ids.has(id)) freshIds.add(id);
      else if (!freshIds.has(id)) { groupCache = null; durationCache = null; freshIds.clear(); }
    }
    if (id) { if (ids.has(id)) id = ids.get(id); else ids.set(id, id); }
    let request;
    if (event.type === 'submitted') {
      const raw = event.data.request, key = JSON.stringify([raw.project, raw.category, raw.work.type]);
      request = requestPool.get(key);
      if (!request) { request = Object.freeze({ project: raw.project, category: raw.category, work: Object.freeze({ type: raw.work.type }) }); requestPool.set(key, request); }
      submissions.set(id, request);
    }
    if (id) { marks.push(at, id); if (at < retainFrom) oldMarkAdded = true; }
    if (['dispatch-intent', 'dispatched'].includes(event.type)) {
      let byAttempt = handoffs.get(id);
      if (!byAttempt) handoffs.set(id, byAttempt = new Map());
      let step = byAttempt.get(event.attemptId);
      if (!step) byAttempt.set(event.attemptId, step = { attemptId: event.attemptId, intentAt: null, dispatchedAt: null, machine: null, submissionId: null,
        firstSeq: event.seq, intentSeq: 0, dispatchedSeq: 0, submissionSeq: 0 });
      step.firstSeq = Math.min(step.firstSeq, event.seq);
      if (event.type === 'dispatch-intent') {
        if (event.seq > step.intentSeq) { step.intentAt = event.at; step.machine = event.data.intent.machine; step.intentSeq = event.seq; }
      } else if (event.seq > step.dispatchedSeq) { step.dispatchedAt = event.at; step.dispatchedSeq = event.seq; }
      if (event.seq > step.submissionSeq) {
        step.submissionId = event.type === 'dispatch-intent' ? event.data.intent.submissionId : event.data.submissionId;
        step.submissionSeq = event.seq;
      }
    }
    const type = ['submitted', 'granted', 'started', 'finished'].indexOf(event.type);
    pending.push(event.seq, at, type, id, event.attemptId, type === 0 ? request : type === 1 && event.data.permit?.ciAware === true);
    projectCache = null;
  }
  function parse(bytes, previousNewline = true) {
    if (!isUtf8(bytes)) throw new Error('台账不是有效 UTF-8');
    let text = bytes.toString('utf8');
    // The reference also accepts a complete JSON value without its final newline.
    if (!previousNewline) {
      const newline = text.indexOf('\n'), suffix = newline < 0 ? text : text.slice(0, newline);
      if (!/^[\t\r ]*$/.test(suffix)) throw new Error('台账末行追加后不是有效 JSON');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    if (!text) return;
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
    for (const line of lines) { const event = JSON.parse(line); validate(event, previousSeq); accept(event); }
  }
  function remember(file, bytes, old = null) {
    file.tail = hash(bytes.subarray(Math.max(0, bytes.length - 4096)));
    file.newline = file.size === 0 || bytes.at(-1) === 10;
    if (bytes.length === 0 && old) file.newline = old.newline;
  }
  function rebuild(next) {
    fullRebuilds++; clear();
    for (const file of next) {
      const before = pending.length, bytes = readRange(file, 0, file.size);
      parse(bytes); file.firstSeq = pending[before] ?? null; file.lastSeq = previousSeq;
      remember(file, bytes);
    }
  }
  function refresh(nextShare, force = false) {
    let next;
    const rebuildsBefore = fullRebuilds;
    try {
      if (share !== nextShare) { share = nextShare; files = []; initialized = false; clear(); }
      next = listing();
      if (!force && initialized && next.length === files.length && next.every((file, i) => signatureEqual(file, files[i]))) return { readable, reason };
      let full = force || !initialized || !readable || next.length < files.length;
      if (!full) for (let i = 0; i < files.length; i++) {
        const old = files[i], file = next[i];
        if (!file || file.name !== old.name || (!signatureEqual(file, old) && file.size <= old.size)) { full = true; break; }
        if (i < files.length - 1 && !signatureEqual(file, old)) { full = true; break; }
      }
      if (full) rebuild(next);
      else {
        for (let i = 0; i < next.length; i++) {
          const file = next[i], old = files[i];
          if (old && signatureEqual(file, old)) { Object.assign(file, { tail: old.tail, newline: old.newline, firstSeq: old.firstSeq, lastSeq: old.lastSeq }); continue; }
          const tailSize = old ? Math.min(old.size, 4096) : 0;
          const bytes = readRange(file, old ? old.size - tailSize : 0, file.size - (old ? old.size : 0) + tailSize);
          if (old && hash(bytes.subarray(0, tailSize)) !== old.tail) { full = true; break; }
          const globalSeq = previousSeq, pendingBefore = pending.length;
          if (old) previousSeq = old.lastSeq;
          parse(bytes.subarray(tailSize), old ? old.newline : true);
          file.firstSeq = old?.firstSeq ?? pending[pendingBefore] ?? null;
          file.lastSeq = previousSeq;
          const nextOld = files.slice(i + 1).find(entry => entry.firstSeq !== null);
          if (nextOld && file.lastSeq >= nextOld.firstSeq) throw new Error('台账校验和或事件顺序不合法');
          previousSeq = Math.max(globalSeq, previousSeq);
          remember(file, bytes, old);
        }
        if (full) rebuild(next);
      }
      let lastSeq = 0;
      for (const file of next) if (file.firstSeq !== null) {
        if (file.firstSeq <= lastSeq) throw new Error('台账校验和或事件顺序不合法');
        lastSeq = file.lastSeq;
      }
      files = next; initialized = true; readable = true; reason = null;
      // Appends older than the active project window must not resurrect expired marks.
      pruneMarks(oldMarkAdded);
    } catch (error) {
      if (fullRebuilds === rebuildsBefore) fullRebuilds++;
      clear(); files = next ?? []; initialized = next !== undefined; readable = false; reason = `读不到调度台账：${error.message}`;
    }
    return { readable, reason };
  }
  function ensureQuery(cursorSeq, nowMs, projects = false) {
    if (!readable || !Number.isFinite(nowMs)) return;
    if ((projects && nowMs - WEEK < retainFrom) || (!projects && (cursorSeq < foldedSeq || nowMs < foldedAt))) {
      refresh(share, true);
      if (!readable) return;
      highNow = nowMs; retainFrom = nowMs - 8 * DAY;
    }
    highNow = Math.max(highNow, nowMs);
    retainFrom = Math.max(retainFrom, highNow - 8 * DAY);
    pruneMarks();
  }
  function pruneMarks(force = false) {
    if (retainFrom === -Infinity || (!force && retainFrom - prunedThrough < DAY)) return;
    let write = 0;
    for (let i = 0; i < marks.length; i += 2) if (marks[i] >= retainFrom) {
      marks[write++] = marks[i]; marks[write++] = marks[i + 1];
    }
    marks.length = write;
    prunedThrough = retainFrom;
    oldMarkAdded = false;
  }
  function addSample(target, ticketId, bucket, sample) {
    let byBucket = target.get(ticketId);
    if (!byBucket) target.set(ticketId, byBucket = new Map());
    const recent = byBucket.get(bucket) ?? [];
    recent.push(sample); recent.sort(newest); if (recent.length > SAMPLE_LIMIT) recent.length = SAMPLE_LIMIT;
    byBucket.set(bucket, recent);
  }
  function apply(seq, at, type, id, attempt, value, startMap, permitMap, target) {
    if (!id || !attempt || type < 1) return;
    const key = JSON.stringify([id, attempt]);
    if (type === 1) permitMap.set(key, value);
    if (type === 2 && !startMap.has(key)) startMap.set(key, at);
    if (type !== 3 || !startMap.has(key)) return;
    const elapsed = at - startMap.get(key); startMap.delete(key);
    if (elapsed < 0 || !Number.isFinite(elapsed)) return;
    const bucket = permitMap.has(key) ? permitMap.get(key) : key;
    const sample = { elapsed, ms: at, seq };
    addSample(target, id, bucket, sample);
    return { bucket, sample };
  }
  function durationSamples(tickets, { cursorSeq = Infinity, nowMs, ciAware = false }) {
    if (!(cursorSeq >= 1) || !(nowMs >= -8640000000000000)) return new Map();
    ensureQuery(cursorSeq, nowMs);
    if (!readable) return new Map();
    if (!pending.length && !tickets.length && cursorSeq >= previousSeq && nowMs >= maxEventAt && durationCache?.[ciAware ? 1 : 0]) {
      return new Map([...durationCache[ciAware ? 1 : 0]].map(([key, value]) => [key, { ...value }]));
    }
    if (pending.length && groupCache && (cursorSeq < previousSeq || nowMs < maxEventAt)) {
      groupCache = null; durationCache = null; freshIds.clear();
    }
    let folded = 0;
    for (let i = 0; i < pending.length; i += 6) {
      const [seq, at, type, id, attempt, value] = pending.slice(i, i + 6);
      if (seq > cursorSeq || !(at <= nowMs)) break;
      if (type === 0) {
        if (groupCache && freshIds.has(id) && requests.has(id)) { groupCache = null; durationCache = null; }
        requests.set(id, value);
      }
      const added = apply(seq, at, type, id, attempt, value, starts, permits, samples);
      if (added && groupCache && freshIds.has(id)) {
        const request = requests.get(id);
        if (!request) { groupCache = null; durationCache = null; }
        else {
          const which = added.bucket === true ? 1 : 0, groups = groupCache[which];
          if (groups) {
            const key = sampleKey(request), recent = groups.get(key) ?? [];
            recent.push(added.sample); recent.sort(newest); if (recent.length > SAMPLE_LIMIT) recent.length = SAMPLE_LIMIT;
            groups.set(key, recent); durationCache[which] = null;
          }
        }
      }
      foldedSeq = seq; foldedAt = Math.max(foldedAt, at); folded += 6;
    }
    if (folded) pending = pending.slice(folded);
    if (!pending.length) freshIds.clear();
    const cachedGroups = !tickets.length && cursorSeq >= previousSeq && nowMs >= maxEventAt ? groupCache?.[ciAware ? 1 : 0] : null;
    if (cachedGroups) {
      const result = summarize(cachedGroups);
      durationCache[ciAware ? 1 : 0] = new Map([...result].map(([key, value]) => [key, { ...value }]));
      return result;
    }
    const finalRequests = new Map(tickets.map(ticket => [ticket.ticketId, ticket.request]));
    for (const [id, request] of requests) finalRequests.set(id, request);
    const startMap = pending.length ? new Map(starts) : starts, permitMap = pending.length ? new Map(permits) : permits, extra = new Map();
    for (let i = 0; i < pending.length; i += 6) {
      const [seq, at, type, id, attempt, value] = pending.slice(i, i + 6);
      if (seq > cursorSeq) break;
      if (type === 0) finalRequests.set(id, value);
      if (at <= nowMs) apply(seq, at, type, id, attempt, value, startMap, permitMap, extra);
    }
    const snapshotPermits = new Map(tickets.flatMap(ticket => ticket.attempts.map(attempt =>
      [JSON.stringify([ticket.ticketId, attempt.attemptId]), attempt.permit?.ciAware === true])));
    const groups = new Map();
    for (const source of [samples, extra]) for (const [id, buckets] of source) {
      const request = finalRequests.get(id); if (!request) continue;
      for (const [bucket, recent] of buckets) {
        const permitted = typeof bucket === 'boolean' ? bucket : snapshotPermits.get(bucket) === true;
        if (permitted !== ciAware) continue;
        const key = sampleKey(request), group = groups.get(key) ?? [];
        group.push(...recent); group.sort(newest); if (group.length > SAMPLE_LIMIT) group.length = SAMPLE_LIMIT;
        groups.set(key, group);
      }
    }
    const result = summarize(groups);
    if (!tickets.length && cursorSeq >= previousSeq && nowMs >= maxEventAt) {
      if (!durationCache) durationCache = [null, null];
      if (!groupCache) groupCache = [null, null];
      groupCache[ciAware ? 1 : 0] = groups;
      durationCache[ciAware ? 1 : 0] = new Map([...result].map(([key, value]) => [key, { ...value }]));
    }
    return result;
  }
  function summarize(groups) {
    return new Map([...groups].map(([key, recent]) => {
      const durations = recent.map(sample => sample.elapsed).sort((a, b) => a - b), middle = Math.floor(durations.length / 2);
      return [key, { sampleCount: durations.length, medianMs: durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 }];
    }));
  }
  function connectedProjects(tickets, nowMs) {
    ensureQuery(Infinity, nowMs, true);
    if (!readable) return { readable: false, names: [], reason };
    if (!tickets.length && projectCache && nowMs >= projectCache.from && nowMs < projectCache.next && nowMs <= projectCache.expiry)
      return { readable: true, names: [...projectCache.names], reason: null };
    const finalRequests = tickets.length ? new Map(tickets.map(ticket => [ticket.ticketId, ticket.request])) : submissions;
    if (tickets.length) for (const [id, request] of submissions) finalRequests.set(id, request);
    const names = new Set(); let next = Infinity, expiry = Infinity;
    for (let i = 0; i < marks.length; i += 2) {
      const at = marks[i], id = marks[i + 1];
      const project = finalRequests.get(id)?.project;
      if (project && at >= nowMs - WEEK && at <= nowMs) names.add(project);
      if (at > nowMs) next = Math.min(next, at);
      else if (at >= nowMs - WEEK) expiry = Math.min(expiry, at + WEEK);
    }
    const sorted = [...names].sort();
    if (!tickets.length && Number.isFinite(nowMs)) projectCache = { from: nowMs, next, expiry, names: sorted };
    return { readable: true, names: [...sorted], reason: null };
  }
  function handoffsFor(ticket) {
    const result = new Map();
    for (const attempt of ticket.attempts) if (attempt.intent) result.set(attempt.attemptId, {
      attemptId: attempt.attemptId, intentAt: null, dispatchedAt: null, machine: attempt.intent.machine, submissionId: attempt.intent.submissionId ?? null });
    const steps = [...(handoffs.get(ticket.ticketId)?.values() ?? [])].sort((a, b) => a.firstSeq - b.firstSeq);
    for (const step of steps) {
      const id = step.attemptId;
      const base = result.get(id) ?? { attemptId: id, intentAt: null, dispatchedAt: null, machine: null, submissionId: null };
      result.set(id, { ...base, intentAt: step.intentAt, dispatchedAt: step.dispatchedAt,
        machine: step.machine ?? base.machine, submissionId: step.submissionId ?? base.submissionId });
    }
    return [...result.values()];
  }
  function history() {
    // Accessors stay live if a query needs a rewind rebuild or encounters a read error.
    return { get readable() { return readable; }, get reason() { return reason; }, events: [], durationSamples, connectedProjects, handoffsFor };
  }
  function recentMarkCount() {
    let count = 0;
    for (let i = 0; i < marks.length; i += 2) if (marks[i] >= retainFrom) count++;
    return count;
  }
  return { refresh, durationSamples, connectedProjects, history,
    stats: () => ({ files: files.length, bytesRead, fullRebuilds, retainedEvents: pending.length / 6, recentMarks: recentMarkCount() }) };
}

let currentShare = null, currentIndex = null;
function ledgerIndexFor(share) {
  if (share !== currentShare || !currentIndex) { currentShare = share; currentIndex = createLedgerIndex(); }
  return currentIndex;
}
function ledgerIndexStats(share) { return share === currentShare && currentIndex ? currentIndex.stats() : null; }
module.exports = { createLedgerIndex, ledgerIndexFor, ledgerIndexStats };
