'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTickets } = require('../core/schedEstimates.cjs');
const { durationSamples, connectedProjects, sampleKey } = require('../core/schedLedger.cjs');
const { ticket, heartbeat, AT } = require('./fixtures/sched/support.cjs');
const NOW = Date.parse(AT) + 3600000;
const iso = ms => new Date(ms).toISOString();

function job(index, state = 'queued', elapsed = 0) {
  const value = ticket(index, { state, machine: state === 'queued' ? null : 'fixture-worker' });
  value.request.allowedMachines = ['fixture-worker'];
  value.attempts[0].startedAt = state === 'queued' || state === 'granted' ? null : iso(NOW - elapsed);
  return value;
}
function machine(overrides = {}) {
  return { ...heartbeat(iso(NOW)).machines[1], quotaCores: 4, grantedCores: 4, availableCores: 0, ...overrides };
}
function snapshot(tickets, machines = [machine()]) {
  return { readable: true, nowMs: NOW, heartbeatAt: iso(NOW), cursorSeq: 10000, tickets, machines, locks: [],
    queue: tickets.filter(value => ['queued', 'unsatisfiable'].includes(value.state)).map((value, index) => ({
      ticketId: value.ticketId, position: index + 1, band: 1, requestedCores: value.request.requestedCores,
      allowedMachines: value.request.allowedMachines, state: value.state, queuedAt: value.createdAt, reason: null,
    })) };
}
function history(durations, category = 'unit-test', type = 'test') {
  let seq = 0, at = NOW - 86400000;
  const events = [];
  durations.forEach((duration, index) => {
    const value = job(index + 1000); value.request.category = category; value.request.work.type = type;
    const push = (kind, data = {}) => events.push({ seq: ++seq, at: iso(at), type: kind, ticketId: value.ticketId, attemptId: 'a1', data });
    push('submitted', { request: value.request }); push('started'); at += duration; push('finished'); at += 1000;
  });
  return { readable: true, reason: null, events };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('中位数与剩余时长决定排队等待、预计完成；输入不可变且可重放', () => {
  const running = job(1, 'running', 4000), first = job(2), second = job(3);
  const input = freeze(snapshot([running, first, second])), samples = freeze(history([8000, 10000, 12000]));
  const before = JSON.stringify([input, samples]), estimates = estimateTickets(input, samples);
  assert.equal(estimates[running.ticketId].finishAt, iso(NOW + 6000));
  assert.equal(estimates[running.ticketId].remainingMs, 6000);
  assert.equal(estimates[running.ticketId].overdue, false);
  assert.equal(estimates[first.ticketId].waitMs, 6000);
  assert.equal(estimates[first.ticketId].startAt, iso(NOW + 6000));
  assert.equal(estimates[second.ticketId].waitMs, 16000);
  assert.deepEqual(estimateTickets(input, samples), estimates);
  assert.equal(JSON.stringify([input, samples]), before);
});

test('超时执行保持占用并报告原因，已有空闲核与其他执行的释放仍可用', () => {
  const running = job(1, 'running', 15000), waiting = job(2), estimates = estimateTickets(snapshot([running, waiting]), history([10000]));
  assert.equal(estimates[running.ticketId].overdue, true);
  assert.equal(estimates[running.ticketId].remainingMs, 0);
  assert.equal(estimates[running.ticketId].finishAt, iso(NOW - 5000));
  const unavailable = { kind: 'unavailable', code: 'overdue', reason: '在跑执行已超出平均耗时' };
  assert.deepEqual(estimates[waiting.ticketId], unavailable);
  const spare = snapshot([running, waiting], [machine({ quotaCores: 8, availableCores: 4 })]);
  assert.equal(estimateTickets(spare, history([10000]))[waiting.ticketId].waitMs, 0);
  const onTime = job(3, 'running', 4000);
  const mixed = snapshot([running, onTime, waiting], [machine({ quotaCores: 8, grantedCores: 8 })]);
  assert.equal(estimateTickets(mixed, history([10000]))[waiting.ticketId].waitMs, 6000);
  waiting.request.requestedCores = 8; mixed.queue[0].requestedCores = 8;
  assert.deepEqual(estimateTickets(mixed, history([10000]))[waiting.ticketId], unavailable);
});

test('四种不可预估原因分别保留，不以零等待冒充', () => {
  const waiting = job(1);
  const cases = [
    [machine({ ci: 'active' }), history([10000]), 'ci', 'CI 在跑'],
    [machine({ reservation: { requestedCores: 5, fulfilledCores: 2, untilAt: null } }), history([10000]), 'reservation', '预留未兑现'],
    [machine({ quotaCores: 3 }), history([10000]), 'capacity', '需求超过容量'],
    [machine(), history([]), 'history', '没有历史样本'],
  ];
  for (const [host, samples, code, reason] of cases) {
    assert.deepEqual(estimateTickets(snapshot([waiting], [host]), samples)[waiting.ticketId], { kind: 'unavailable', code, reason });
  }
});

test('只选允许且在线新鲜的机器；在跑机器缺失不编造完成时间，只登记单不受影响', () => {
  const waiting = job(1); waiting.request.allowedMachines.push('fixture-alternative');
  const input = snapshot([waiting], [machine({ ci: 'active' }), machine({ name: 'fixture-alternative', grantedCores: 0, availableCores: 4 }),
    machine({ name: 'not-allowed', grantedCores: 0, availableCores: 100 })]);
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].machine, 'fixture-alternative');
  input.machines[1].fresh = false;
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'ci');
  input.machines[0].ci = 'idle'; input.machines[0].online = false;
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'unavailable');
  const running = job(2, 'running', 4000);
  for (const hosts of [[], [machine({ name: 'fixture-alternative' })]]) {
    assert.deepEqual(estimateTickets(snapshot([running], hosts), history([10000]))[running.ticketId],
      { kind: 'unavailable', code: 'missingMachine', reason: '执行所在机器已不在快照中' });
  }
  for (const host of [machine({ online: false }), machine({ fresh: false }), machine({ heartbeatAt: iso(NOW - 31000) })]) {
    assert.equal(estimateTickets(snapshot([running], [host]), history([10000]))[running.ticketId].code, 'unavailable');
  }
  const registered = ticket(3, { state: 'running', registerOnly: true, machine: null });
  registered.attempts[0].startedAt = iso(NOW - 4000);
  assert.equal(estimateTickets(snapshot([registered], []), history([10000], 'codex-build'))[registered.ticketId].finishAt, iso(NOW + 6000));
});

test('不能用配额冒充当前可派核；已兑现预留与小数外部负载保持占用', () => {
  const waiting = job(1), host = machine({ quotaCores: 20, grantedCores: 0, availableCores: 2.75,
    reservation: { requestedCores: 5, fulfilledCores: 5, untilAt: null }, externalLoadCores: 12.25 });
  assert.equal(estimateTickets(snapshot([waiting], [host]), history([10000]))[waiting.ticketId].code, 'load');
});

test('超额占用先偿还超出的核数，不提前预报可派', () => {
  const running = job(1, 'running', 4000), waiting = job(2);
  const host = machine({ overCommitted: true, quotaCores: 4, grantedCores: 4, externalLoadCores: 2, availableCores: 0 });
  assert.equal(estimateTickets(snapshot([running, waiting], [host]), history([10000]))[waiting.ticketId].code, 'load');
});

test('保护队首未来核数，允许别的机器补位；被保护的机器不提前插空', () => {
  const running = job(1, 'running', 4000), head = job(2), small = job(3), other = job(4);
  head.request.requestedCores = 8; small.request.requestedCores = 1; small.request.work.type = 'quick'; other.request.allowedMachines = ['fixture-alternative'];
  const input = snapshot([running, head, small, other], [machine({ quotaCores: 8, availableCores: 4 }), machine({ name: 'fixture-alternative', availableCores: 4, grantedCores: 0 })]);
  input.locks = [{ machine: 'fixture-worker', byTicketId: head.ticketId }];
  const samples = history([10000]), quick = history([1000], 'unit-test', 'quick');
  samples.events.push(...quick.events.map(event => ({ ...event, seq: event.seq + 3, ticketId: job(9000).ticketId })));
  const result = estimateTickets(input, samples);
  assert.equal(result[head.ticketId].waitMs, 6000);
  assert.equal(result[small.ticketId].waitMs, 16000);
  assert.equal(result[other.ticketId].waitMs, 0);
  input.locks = [];
  assert.equal(estimateTickets(input, samples)[small.ticketId].waitMs, 0);
});

test('无法满足的队首不挡后单；没有历史的在跑单不凭空释放核数', () => {
  const oversized = job(1), waiting = job(2); oversized.state = 'unsatisfiable'; oversized.request.requestedCores = 99;
  let result = estimateTickets(snapshot([oversized, waiting], [machine({ grantedCores: 0, availableCores: 4 })]), history([10000]));
  assert.equal(result[oversized.ticketId].code, 'capacity'); assert.equal(result[waiting.ticketId].waitMs, 0);
  const running = job(3, 'running', 4000); running.request.work.type = 'unsampled-work';
  result = estimateTickets(snapshot([running, waiting]), history([10000]));
  assert.equal(result[waiting.ticketId].code, 'history');
});

test('分组最近二十次，偶数中位数；不同作业、无开跑的结束与未结束执行均不串样本', () => {
  const samples = history(Array.from({ length: 22 }, (_, index) => (index + 1) * 1000));
  const request = job(1).request, key = sampleKey(request);
  const latest = samples.events.at(-1);
  samples.events.push({ ...latest, seq: latest.seq + 1, attemptId: 'a2' }, { ...latest, seq: latest.seq + 2, attemptId: 'a3', type: 'started' });
  const grouped = durationSamples([], samples.events, NOW);
  assert.deepEqual(grouped.get(key), { sampleCount: 20, medianMs: 12500 });
  assert.equal(grouped.has(sampleKey({ ...request, work: { type: 'another-work' } })), false);
  const sameTicket = history([1000]);
  const base = sameTicket.events.at(-1);
  sameTicket.events.push({ ...base, seq: 4, attemptId: 'a2', type: 'started', at: iso(NOW - 4000) },
    { ...base, seq: 5, attemptId: 'a2', type: 'finished', at: iso(NOW - 1000) });
  assert.deepEqual(durationSamples([], sameTicket.events, NOW).get(key), { sampleCount: 2, medianMs: 2000 });
});

test('台账、快照不可读或过期时降级，不抛异常也不返回虚假时间', () => {
  const waiting = job(1), input = snapshot([waiting]);
  assert.equal(estimateTickets(input, { readable: false })[waiting.ticketId].code, 'ledger');
  input.heartbeatAt = iso(NOW - 61000);
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'snapshot');
  assert.deepEqual(estimateTickets({ readable: false, tickets: null, queue: null, machines: null }, null), {});
  input.heartbeatAt = iso(NOW); input.cursorSeq = 1;
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'history');
  input.tickets[0].lastSeq = 2;
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'snapshot');
});

test('接入项目只来自最近七天的事件，支持旧单新事件、去重与不可读提示', () => {
  const old = job(1); old.request.project = 'fixture-older-project';
  const recent = job(2); recent.request.project = 'fixture-new-project';
  const event = (ticketId, at) => ({ ticketId, type: 'started', at: iso(at), data: {} });
  const data = { readable: true, reason: null, events: [event(old.ticketId, NOW - 8 * 86400000), event(recent.ticketId, NOW), event(recent.ticketId, NOW - 1000), event(old.ticketId, NOW + 1)] };
  assert.deepEqual(connectedProjects([old, recent], data, NOW).names, ['fixture-new-project']);
  data.events.push(event(old.ticketId, NOW - 7 * 86400000));
  assert.deepEqual(connectedProjects([old, recent], data, NOW).names, ['fixture-new-project', 'fixture-older-project']);
  assert.deepEqual(connectedProjects([], { readable: false, reason: 'fixture-unreadable' }, NOW), { readable: false, names: [], reason: 'fixture-unreadable' });
});
