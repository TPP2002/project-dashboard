'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTickets, CI_AWARE_SLOWDOWN } = require('../core/schedEstimates.cjs');
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

test('CI 在跑且有可派核仍给等待估值；CI 余量只标注，不重复扣核', () => {
  const first = job(1), second = job(2), host = machine({ ci: 'active', quotaCores: 12, grantedCores: 0, availableCores: 4, ciReserveCores: 8 });
  const input = freeze(snapshot([first, second], [host])), samples = freeze(history([8000, 10000, 12000]));
  const before = JSON.stringify([input, samples]), result = estimateTickets(input, samples);
  const expected = { kind: 'wait', sampleCount: 3, medianMs: 10000, ciHeadroom: 8, machine: 'fixture-worker', startAt: iso(NOW), waitMs: 0 };
  assert.deepEqual(result[first.ticketId], expected);
  assert.deepEqual(result[second.ticketId], { ...expected, startAt: iso(NOW + 10000), waitMs: 10000 });
  assert.deepEqual(estimateTickets(input, samples), result);
  assert.equal(JSON.stringify([input, samples]), before);
  assert.deepEqual(estimateTickets(snapshot([first], [{ ...host, ciReserveCores: 0 }]), samples)[first.ticketId], { ...expected, ciHeadroom: 0 });
  assert.equal(estimateTickets(snapshot([first], [{ ...host, availableCores: 3.75 }]), samples)[first.ticketId].code, 'load');
});

test('ciAware 在跑按中位耗时的 1.5 倍估完成，排队等待沿用同一释放时刻', () => {
  assert.equal(CI_AWARE_SLOWDOWN, 1.5);
  const running = job(1, 'running', 4000), waiting = job(2), samples = history([8000, 10000, 12000]);
  running.attempts[0].permit.ciAware = true;
  const input = snapshot([running, waiting], [machine({ ci: 'active', quotaCores: 12, ciReserveCores: 8 })]);
  const completion = { kind: 'completion', sampleCount: 3, medianMs: 10000, slowdown: 1.5,
    finishAt: iso(NOW + 11000), remainingMs: 11000, overdue: false, ciHeadroom: 8 };
  const wait = { kind: 'wait', sampleCount: 3, medianMs: 10000, ciHeadroom: 8, machine: 'fixture-worker', startAt: iso(NOW + 11000), waitMs: 11000 };
  for (const state of ['running', 'slow']) for (const pauseReasons of [[], ['ci']]) {
    running.state = state; running.pauseReasons = pauseReasons;
    assert.deepEqual(estimateTickets(input, samples), { [running.ticketId]: completion, [waiting.ticketId]: wait });
  }
  const calibrated = estimateTickets(input, samples, { ciAwareSlowdown: 2 });
  assert.deepEqual(calibrated[running.ticketId], { ...completion, slowdown: 2, finishAt: iso(NOW + 16000), remainingMs: 16000 });
  assert.deepEqual(calibrated[waiting.ticketId], { ...wait, startAt: iso(NOW + 16000), waitMs: 16000 });
  // 系数来自本次许可，CI 结束后仍按这次低优先级执行估，不能由整机状态反推许可。
  input.machines[0].ci = 'idle';
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], completion);
  for (const ciAwareSlowdown of [0, 0.5, NaN, Infinity, '1.5']) assert.throws(() => estimateTickets(input, samples, { ciAwareSlowdown }), RangeError);
});

test('被 CI 冻住且没有 ciAware 真值的执行算不出，并把原因传给等待释放的单子', () => {
  const running = job(1, 'paused', 4000), waiting = job(2), samples = history([10000]);
  running.pauseReasons = ['ci'];
  const input = snapshot([running, waiting], [machine({ ci: 'active' })]);
  const frozen = { kind: 'unavailable', code: 'ci', reason: '被 CI 冻住，恢复时刻未知' };
  for (const ciAware of [undefined, false, 'true']) {
    if (ciAware === undefined) delete running.attempts[0].permit.ciAware;
    else running.attempts[0].permit.ciAware = ciAware;
    assert.deepEqual(estimateTickets(input, samples), { [running.ticketId]: frozen, [waiting.ticketId]: frozen });
  }
  input.machines[0].quotaCores = 12; input.machines[0].ciReserveCores = 8;
  const frozenWithHeadroom = { ...frozen, ciHeadroom: 8 };
  assert.deepEqual(estimateTickets(input, samples), { [running.ticketId]: frozenWithHeadroom, [waiting.ticketId]: frozenWithHeadroom });
  input.machines[0].quotaCores = 16; input.machines[0].availableCores = 4;
  assert.equal(estimateTickets(input, samples)[waiting.ticketId].waitMs, 0);
});

test('CI 状态未知时，即使有可派核或 ciAware 许可也仍 unavailable', () => {
  const running = job(1, 'running', 4000), waiting = job(2); running.attempts[0].permit.ciAware = true;
  const input = snapshot([running, waiting], [machine({ ci: 'unknown', quotaCores: 8, availableCores: 4 })]);
  const unavailable = { kind: 'unavailable', code: 'unavailable', reason: '允许使用的机器离线、读数过期，或暂时不能接活' };
  assert.deepEqual(estimateTickets(input, history([10000])), { [running.ticketId]: unavailable, [waiting.ticketId]: unavailable });
});

test('ciAware 不掩盖真正暂停、其他原因降速、未开跑和缺少历史', () => {
  const running = job(1, 'paused', 4000); running.attempts[0].permit.ciAware = true;
  const input = snapshot([running], [machine({ ci: 'active' })]), samples = history([10000]);
  const paused = { kind: 'unavailable', code: 'paused', reason: '任务已暂停或降速，何时恢复还不知道' };
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], paused);
  running.state = 'slow'; running.pauseReasons = ['ci', 'manual'];
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], paused);
  running.pauseReasons = []; running.attempts[0].permit.ciAware = false;
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], paused);
  running.state = 'running';
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], { kind: 'completion', sampleCount: 1, medianMs: 10000,
    finishAt: iso(NOW + 6000), remainingMs: 6000, overdue: false });
  running.attempts[0].permit.ciAware = true;
  assert.deepEqual(estimateTickets(input, history([]))[running.ticketId], { kind: 'unavailable', code: 'history', reason: '还没有同类任务的历史耗时' });
  running.state = 'granted'; running.attempts[0].startedAt = null;
  assert.deepEqual(estimateTickets(input, samples)[running.ticketId], { kind: 'unavailable', code: 'start', reason: '还没收到任务开跑的消息' });
});

test('超时执行保持占用并报告原因，已有空闲核与其他执行的释放仍可用', () => {
  const running = job(1, 'running', 15000), waiting = job(2), estimates = estimateTickets(snapshot([running, waiting]), history([10000]));
  assert.equal(estimates[running.ticketId].overdue, true);
  assert.equal(estimates[running.ticketId].remainingMs, 0);
  assert.equal(estimates[running.ticketId].finishAt, iso(NOW - 5000));
  // 金样文案改为预计耗时：依据是历史中位数，ciAware 时还包含低优先级系数，并非算术平均。
  const unavailable = { kind: 'unavailable', code: 'overdue', reason: '任务已超过预计耗时，何时结束还不知道' };
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
    // 金样变化：CI 不再封锁整机；本夹具无可派核、也无可知的释放，故原因由 ci 改为 load。
    [machine({ ci: 'active' }), history([10000]), 'load', '正在占用的核数何时能腾出来还不知道'],
    // 以下三项只把原因改成人话，原阻断条件与结果形状不变。
    [machine({ reservation: { requestedCores: 5, fulfilledCores: 2, untilAt: null } }), history([10000]), 'reservation', '预留的核数还没腾出来'],
    [machine({ quotaCores: 3 }), history([10000]), 'capacity', '这项任务要的核数超过了允许机器的容量'],
    [machine(), history([]), 'history', '还没有同类任务的历史耗时'],
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
  // 金样变化：另一台机器过期后，CI 活跃机器仍可尝试估，但本夹具没有已知释放时刻。
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'load');
  input.machines[0].ci = 'idle'; input.machines[0].online = false;
  assert.equal(estimateTickets(input, history([10000]))[waiting.ticketId].code, 'unavailable');
  const running = job(2, 'running', 4000);
  for (const hosts of [[], [machine({ name: 'fixture-alternative' })]]) {
    // 仅文案变化，机器缺失时仍不可估算，不用旧机器信息编造完成时刻。
    assert.deepEqual(estimateTickets(snapshot([running], hosts), history([10000]))[running.ticketId],
      { kind: 'unavailable', code: 'missingMachine', reason: '找不到这项任务所在机器的最新信息' });
  }
  for (const host of [machine({ online: false }), machine({ fresh: false }), machine({ heartbeatAt: iso(NOW - 31000) }),
    machine({ ci: 'active', ownerHold: true }), machine({ ci: 'active', loadSampledAt: iso(NOW - 31000) })]) {
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
  input.locks = [{ machine: 'fixture-worker', byTicketId: head.ticketId }];
  input.machines[0].ci = 'active'; running.attempts[0].permit.ciAware = true;
  const duringCI = estimateTickets(input, samples);
  assert.equal(duringCI[head.ticketId].waitMs, 11000);
  assert.equal(duringCI[small.ticketId].waitMs, 21000);
  assert.equal(duringCI[other.ticketId].waitMs, 0);
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
