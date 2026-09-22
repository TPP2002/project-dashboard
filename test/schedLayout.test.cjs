'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeEngine, engineFilterValue, matchesEngine, engineOptions, groupExternalTickets } = require('../core/schedEngines.cjs');
const { createSchedApi } = require('../server/schedApi.cjs');
const { contentHash } = require('../core/schedContract.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');

const external = (ticketId, engine, state = 'running') => Object.freeze({ ticketId, engine, registerOnly: true, state });

test('施工方窗口来自数据，支持任意新增平台；缺字段归未标注，不改变原快照', () => {
  const active = Object.freeze([
    external('one', 'fixture-z'), external('two', 'fixture-a'), external('three', 'fixture-z'),
    external('four', undefined), external('five', 'future-platform'),
  ]);
  const groups = groupExternalTickets(active);
  assert.deepEqual(groups.map(group => group.engine), ['fixture-a', 'fixture-z', 'future-platform', null]);
  assert.deepEqual(groups.map(group => group.tickets.map(row => row.ticketId)), [['two'], ['one', 'three'], ['five'], ['four']]);
  assert.equal(groups[1].tickets[0], active[0]);
  assert.deepEqual(groupExternalTickets(active), groups, '同输入重复投影结果相同');
});

test('已结束外派单留下空窗口，非外派单不产生窗口；窗口内容只用在跑的 registerOnly 单', () => {
  const running = external('running', 'fixture-active');
  const completed = external('completed', 'fixture-idle', 'passed');
  const ordinary = { ticketId: 'ordinary', engine: 'fixture-compute', registerOnly: false, state: 'running' };
  const groups = groupExternalTickets([running, completed, ordinary], [running, completed, ordinary]);
  assert.deepEqual(groups, [{ engine: 'fixture-active', tickets: [running] }, { engine: 'fixture-idle', tickets: [] }]);
  assert.deepEqual(groupExternalTickets([], [completed]), [{ engine: 'fixture-idle', tickets: [] }]);
  assert.deepEqual(groupExternalTickets([running], []), [{ engine: 'fixture-active', tickets: [running] }]);
});

test('字段缺失或脏值归未标注，未读到数据安全返回空投影，真实标识不与筛选哨兵碰撞', () => {
  for (const missing of [undefined, null, '', '  ', 4, {}, []]) assert.equal(normalizeEngine(missing), null);
  assert.equal(normalizeEngine(' fixture-a '), 'fixture-a');
  for (const missing of [undefined, null, {}, '', [null, undefined, 2, []]]) {
    assert.deepEqual(groupExternalTickets(missing), []);
    assert.deepEqual(engineOptions(missing), []);
  }
  const choices = engineOptions([{ engine: 'fixture-a' }, {}, { engine: null }, { engine: 'missing:' }, { engine: 'fixture-a' }]);
  assert.deepEqual(choices.map(option => option.label), ['fixture-a', 'missing:', '未标注']);
  assert.equal(new Set(choices.map(option => option.value)).size, 3);
  const missing = choices.find(option => option.label === '未标注').value;
  assert.equal(matchesEngine(undefined, missing), true);
  assert.equal(matchesEngine('missing:', missing), false);
  assert.equal(matchesEngine('fixture-a', ''), true);
});

// 使用真实路由与真实读盘，只收集 HTTP 输出；不启动服务、不触碰真实共享盘或指令通道。
function apiFixture(t, readable = true) {
  const share = temporary(t), paths = readable ? initialize(share) : null;
  if (paths) fs.mkdirSync(path.join(paths.root, 'ledger'));
  const api = createSchedApi({ resolveShare: () => share, sources: { now: () => Date.parse(AT) + 3600000, nonce: () => 'fixture' },
    bodyMax: 1024,
    readBody: () => { throw new Error('布局读盘用例不能发指令'); },
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
  });
  function get(action, query = {}) {
    const res = { status: null, body: null, headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    assert.equal(api.route(action, { method: 'GET' }, res, query), true);
    return res;
  }
  function save(index, engine, options = {}) {
    const record = ticket(index, options);
    if (engine !== undefined) record.request.engine = engine;
    record.contentHash = contentHash(record.request);
    record.timeline[0].data.contentHash = record.contentHash;
    write(path.join(paths.tickets, `${record.ticketId}.json`), record);
    return record;
  }
  return { get, save };
}

test('快照透传施工方，分组与原 registerOnly 数据一致，并保留已无在跑单的窗口', t => {
  const api = apiFixture(t);
  const active = api.save(1, 'fixture-a', { registerOnly: true, state: 'running' });
  api.save(2, 'fixture-b', { registerOnly: true });
  const unlabelled = api.save(3, undefined, { registerOnly: true, state: 'running' });
  api.save(4, 'fixture-compute', { state: 'running' });
  const result = api.get('snapshot');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.registerOnly.map(row => row.ticketId), [active.ticketId, unlabelled.ticketId]);
  assert.deepEqual(result.body.registerOnlyGroups.map(group => [group.engine, group.tickets.map(row => row.ticketId)]), [
    ['fixture-a', [active.ticketId]], ['fixture-b', []], [null, [unlabelled.ticketId]],
  ]);
  assert.deepEqual(result.body.registerOnlyGroups.flatMap(group => group.tickets), result.body.registerOnly);
  assert.ok(result.body.estimates); assert.ok(result.body.connectedProjects);
  assert.equal(result.body.machines[0].externalLoadCores, 1.25);
});

test('台账施工方筛选与导出一致，动态选项不受当前页或其他筛选限制，游标绑定施工方', t => {
  const api = apiFixture(t);
  const first = api.save(1, 'fixture-a'), second = api.save(2, 'fixture-a');
  const other = api.save(3, 'fixture-b', { project: 'fixture-other' });
  const unlabelled = api.save(4, undefined);
  const page = api.get('tickets', { engine: engineFilterValue('fixture-a'), limit: '1' });
  assert.equal(page.status, 200); assert.equal(page.body.total, 2);
  assert.equal(page.body.items[0].ticketId, second.ticketId);
  assert.equal(page.body.items[0].engine, 'fixture-a');
  assert.deepEqual(page.body.filters.engines.map(option => option.label), ['fixture-a', 'fixture-b', '未标注']);
  assert.deepEqual(api.get('tickets', { project: 'fixture-other' }).body.filters.engines, page.body.filters.engines);
  const next = api.get('tickets', { engine: engineFilterValue('fixture-a'), limit: '1', cursor: page.body.nextCursor });
  assert.deepEqual(next.body.items.map(row => row.ticketId), [first.ticketId]);
  assert.equal(api.get('tickets', { engine: engineFilterValue('fixture-b'), cursor: page.body.nextCursor }).status, 400);
  const csv = api.get('tickets.csv', { engine: engineFilterValue('fixture-a'), limit: '1' });
  assert.equal(csv.status, 200); assert.equal(csv.body.charCodeAt(0), 0xFEFF);
  assert.ok(csv.body.includes(first.ticketId)); assert.ok(csv.body.includes(second.ticketId));
  assert.equal(csv.body.includes(other.ticketId), false); assert.equal(csv.body.includes(unlabelled.ticketId), false);
  assert.equal(csv.body.split('\r\n').filter(Boolean).length, 3);
  const missing = api.get('tickets', { engine: engineFilterValue(null) });
  assert.deepEqual(missing.body.items.map(row => row.ticketId), [unlabelled.ticketId]);
  assert.equal(api.get('tickets', { engine: ['invalid'] }).status, 400);
});

test('旧挂号请求及脏施工方字段仍可读，共享盘不可读由路由降级而不抛出', t => {
  const api = apiFixture(t);
  for (const [index, engine] of [undefined, null, '', 7, {}].entries()) api.save(index + 1, engine, { registerOnly: true, state: 'running' });
  const snapshot = api.get('snapshot');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.registerOnlyGroups.length, 1); assert.equal(snapshot.body.registerOnlyGroups[0].engine, null);
  assert.equal(snapshot.body.registerOnlyGroups[0].tickets.length, 5);
  assert.equal(api.get('tickets', { engine: engineFilterValue(null) }).body.total, 5);
  const unreadable = apiFixture(t, false);
  for (const action of ['snapshot', 'tickets', 'tickets.csv']) {
    let result;
    assert.doesNotThrow(() => { result = unreadable.get(action); });
    assert.equal(result.status, 503); assert.equal(result.body.readable, false);
    if (action === 'snapshot') assert.equal(result.body.registerOnlyGroups, null);
  }
});
