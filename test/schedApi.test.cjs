'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../core/schedContract.cjs');
const { startServer, heartbeat, ticket, openStream, write, AT } = require('./fixtures/sched/support.cjs');
const saveTicket = (srv, value) => write(path.join(srv.paths.tickets, `${value.ticketId}.json`), value);
const commandFiles = srv => fs.readdirSync(srv.paths.commands).filter(name => name.endsWith('.json'));

test('真服务快照：原样决策、四种在跑状态、零核施工单、最新 20 条回执与旧预留', async t => {
  const srv = await startServer(t);
  const hb = heartbeat(new Date(Date.now() - 65000).toISOString());
  const queued = ticket(1, { state: 'queued', machine: null }); saveTicket(srv, queued);
  hb.queue = [{ ticketId: queued.ticketId, position: 1, band: 1, requestedCores: 4, allowedMachines: ['fixture-host'], queuedAt: AT, state: 'queued', reason: null }];
  hb.queued = 1; hb.locks = [{ machine: 'fixture-host', byTicketId: queued.ticketId }]; write(srv.paths.heartbeat, hb);
  for (const [index, state] of ['granted', 'running', 'paused', 'slow'].entries()) saveTicket(srv, ticket(index + 2, { state }));
  const build = ticket(6, { state: 'running', registerOnly: true }); saveTicket(srv, build);
  for (let index = 0; index < 25; index++) write(path.join(srv.paths.commandReceipts, `receipt-${index}.json`), {
    commandId: `receipt-${index}`, status: 'executed', at: new Date(Date.parse(AT) + index * 1000).toISOString(),
  });
  const result = await srv.json('/api/sched/snapshot');
  assert.equal(result.status, 200); assert.equal(result.body.readable, true); assert.equal(result.body.share, srv.share);
  assert.deepEqual(result.body.dispatcher.heartbeat, hb); assert.ok(result.body.dispatcher.heartbeatAgeMs >= 65000);
  assert.deepEqual(result.body.machines, hb.machines); assert.deepEqual(result.body.queue, hb.queue); assert.deepEqual(result.body.locks, hb.locks);
  assert.equal(result.body.machines[0].availableCores, 2.75, '不得拿配额重算可派核数');
  assert.equal(result.body.running.length, 5); assert.deepEqual(result.body.registerOnly.map(item => item.ticketId), [build.ticketId]);
  assert.equal(result.body.recentReceipts.length, 20); assert.equal(result.body.recentReceipts[0].commandId, 'receipt-24');
  assert.equal(result.body.recentReceipts[19].commandId, 'receipt-5');
  assert.deepEqual(result.body.legacyReserve, { reservedCores: 0, reserveExpiresAt: null });
});

test('真服务台账：项目/机器/派单方/结果/日期筛选、稳定游标、四段时长和详情全文', async t => {
  const srv = await startServer(t);
  const records = [ticket(1), ticket(2), ticket(3), ticket(4, { project: 'other', state: 'failed', submitter: 'other-dispatcher', machine: 'fixture-host' })];
  for (const value of records) saveTicket(srv, value);
  let result = await srv.json('/api/sched/tickets?limit=2');
  assert.equal(result.status, 200); assert.equal(result.body.total, 4);
  assert.deepEqual(result.body.items.map(item => item.ticketId), [records[3].ticketId, records[2].ticketId]);
  const cursor = result.body.nextCursor;
  saveTicket(srv, ticket(5)); // 新单到达不使下一页重复上一页的记录。
  result = await srv.json(`/api/sched/tickets?limit=2&cursor=${cursor}`);
  assert.deepEqual(result.body.items.map(item => item.ticketId), [records[1].ticketId, records[0].ticketId]); assert.equal(result.body.nextCursor, null);
  result = await srv.json('/api/sched/tickets?project=other&machine=fixture-host&submitter=other-dispatcher&result=failed&from=2026-09-12&to=2026-09-12');
  assert.equal(result.body.total, 1); assert.equal(result.body.items[0].ticketId, records[3].ticketId);
  for (const key of ['queuedMs', 'runningMs', 'pausedMs', 'slowMs']) assert.equal(result.body.items[0][key], records[3].timing[key]);
  assert.equal(result.body.items[0].endedAt, records[3].endedAt);
  assert.deepEqual(result.body.filters.projects, ['other', 'sample']);
  assert.equal((await srv.json('/api/sched/tickets?project=missing')).body.total, 0);
  assert.equal((await srv.json('/api/sched/tickets?from=2026-09-13')).body.total, 0);
  assert.equal((await srv.json('/api/sched/tickets?limit=999')).body.limit, 200);
  assert.equal((await srv.json('/api/sched/tickets')).body.limit, 50);
  for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=x', 'cursor=garbage', 'from=yesterday', 'from=2026-02-30', 'from=2026-09-13&to=2026-09-12', 'result=unknown', `cursor=${cursor}&project=other`]) {
    assert.equal((await srv.json(`/api/sched/tickets?${query}`)).status, 400, query);
  }
  result = await srv.json(`/api/sched/ticket/${records[0].ticketId}`);
  assert.equal(result.status, 200); assert.deepEqual(result.body.ticket, records[0]);
  for (const id of ['tk-xyz', '..%2Fdispatcher.json', 'tk-0123456789abcdef0123%2Fextra']) assert.equal((await srv.json(`/api/sched/ticket/${id}`)).status, 400);
  assert.equal((await srv.json('/api/sched/ticket/tk-ffffffffffffffffffff')).status, 404);
});

test('五种指令原子写入：主机名由配置补齐、时间十分钟、同源放行、字段不可夹带', async t => {
  const srv = await startServer(t);
  const id = ticket(1).ticketId;
  for (const input of [{ kind: 'jump-queue', data: { ticketId: id } }, { kind: 'cancel', data: { ticketId: id } },
    { kind: 'owner-hold', data: {} }, { kind: 'owner-release', data: {} }, { kind: 'reserve', data: { requestedCores: 5 } }]) {
    const result = await srv.json('/api/sched/command', input, { Origin: srv.base });
    assert.equal(result.status, 200); assert.equal(result.body.ok, true);
    const file = path.join(srv.paths.commands, result.body.commandId + '.json');
    const command = c.readJson(file); c.validateCommand(command);
    assert.equal(command.submitter, 'dashboard'); assert.equal(command.kind, input.kind);
    assert.equal(Date.parse(command.expiresAt) - Date.parse(command.createdAt), 600000);
    assert.equal(fs.readFileSync(file, 'utf8'), c.canonicalJson(command));
    assert.deepEqual(command.data, ['reserve', 'owner-hold', 'owner-release'].includes(input.kind) ? { ...input.data, machine: 'fixture-host' } : input.data);
    assert.deepEqual(fs.readdirSync(srv.paths.staging), []);
  }
  const before = commandFiles(srv);
  for (const body of [null, [], { kind: 'owner-hold', data: { machine: 'attacker' } }, { kind: 'owner-release', data: { machine: 'attacker' } },
    { kind: 'reserve', data: { machine: 'attacker', requestedCores: 5 } }, { kind: 'reserve', data: { requestedCores: 0, durationMinutes: 60 } },
    { kind: 'reserve', data: { requestedCores: 5, durationMinutes: 30 } }, { kind: 'reserve', data: { requestedCores: '5' } },
    { kind: 'cancel', data: { ticketId: '../escape' } }, { kind: 'owner-hold', data: {}, submitter: 'other' }]) {
    assert.equal((await srv.json('/api/sched/command', body)).status, 400, JSON.stringify(body));
  }
  for (const kind of ['pause-one', 'resume-one']) {
    const result = await srv.json('/api/sched/command', { kind, data: { ticketId: id } });
    assert.equal(result.status, 400); assert.equal(result.body.error, '本期未开放');
  }
  assert.deepEqual(commandFiles(srv), before);
  for (const endpoint of ['/api/sched/command', '/api/sched/legacy-reserve']) {
    assert.equal((await srv.json(endpoint, { requestedCores: 10 }, { Origin: 'https://example.invalid' })).status, 403);
  }
  assert.deepEqual(commandFiles(srv), before);
});

test('预留双写：四档、两种到期时间与手动期限，0 核清除且不动普通租约', async t => {
  const srv = await startServer(t), reserveFile = path.join(srv.legacy, 'reserve-owner.json');
  const cpu = (await srv.json('/api/cpu')).body.cpu;
  const ordinary = path.join(srv.legacy, 'worker.json'); fs.writeFileSync(ordinary, 'ordinary-lease-sentinel');
  for (const cores of [5, 10, 15]) for (const duration of [undefined, 60, 180]) {
    const data = { requestedCores: cores, ...(duration ? { durationMinutes: duration } : {}) };
    const result = await srv.json('/api/sched/command', { kind: 'reserve', data });
    assert.equal(result.status, 200); assert.deepEqual(result.body.legacy, { ok: true });
    const command = c.readJson(path.join(srv.paths.commands, result.body.commandId + '.json'));
    const reserve = c.readJson(reserveFile);
    assert.equal(reserve.cores, Math.min(cores, cpu.quota), '旧账本保留它自己的导出函数配额规则');
    if (duration) assert.equal(reserve.expiresAt, new Date(Date.parse(command.createdAt) + duration * 60000).toISOString());
    else assert.equal(reserve.expiresAt, undefined);
  }
  const result = await srv.json('/api/sched/command', { kind: 'reserve', data: { requestedCores: 0 } });
  assert.deepEqual(result.body.legacy, { ok: true }); assert.equal(fs.existsSync(reserveFile), false);
  assert.equal(fs.readFileSync(ordinary, 'utf8'), 'ordinary-lease-sentinel');
  assert.deepEqual((await srv.json('/api/sched/snapshot')).body.legacyReserve, { reservedCores: 0, reserveExpiresAt: null });
});

test('旧账本写失败仍保留已提交指令并回报；重试只同步旧账本，输入仍严格校验', async t => {
  const srv = await startServer(t), reserveFile = path.join(srv.legacy, 'reserve-owner.json');
  fs.mkdirSync(reserveFile);
  const result = await srv.json('/api/sched/command', { kind: 'reserve', data: { requestedCores: 5, durationMinutes: 60 } });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.legacy.ok, false); assert.ok(result.body.legacy.error);
  assert.ok(fs.existsSync(path.join(srv.paths.commands, result.body.commandId + '.json')));
  const before = commandFiles(srv);
  assert.equal((await srv.json('/api/sched/legacy-reserve', { requestedCores: 5 })).body.legacy.ok, false);
  fs.rmdirSync(reserveFile);
  const start = Date.now();
  const retried = await srv.json('/api/sched/legacy-reserve', { requestedCores: 5, durationMinutes: 60 });
  assert.deepEqual(retried.body, { ok: true, legacy: { ok: true } });
  const expires = Date.parse(c.readJson(reserveFile).expiresAt);
  assert.ok(expires >= start + 3600000 && expires <= Date.now() + 3600000);
  assert.deepEqual(commandFiles(srv), before);
  for (const body of [{ requestedCores: 5, machine: 'attacker' }, { requestedCores: 0, durationMinutes: 180 }, { requestedCores: 5, durationMinutes: null }]) {
    assert.equal((await srv.json('/api/sched/legacy-reserve', body)).status, 400);
  }
});

test('共享盘任何一处缺失或损坏都报不可读，不返回空队列；不存在的单子与盘不可读分开', async t => {
  const srv = await startServer(t), record = ticket(1); saveTicket(srv, record);
  const receiptPath = path.join(srv.paths.commandReceipts, 'fixture-receipt.json');
  write(receiptPath, { commandId: 'fixture-receipt', status: 'rejected', at: AT, reason: 'fixture refusal' });
  for (const file of [srv.paths.format, srv.paths.dispatcher, srv.paths.heartbeat, srv.paths.tickets, srv.paths.commandReceipts,
    path.join(srv.paths.tickets, record.ticketId + '.json'), receiptPath]) {
    if (file.endsWith('.json') && ![srv.paths.format, srv.paths.dispatcher, srv.paths.heartbeat].includes(file)) {
      const original = fs.readFileSync(file); fs.writeFileSync(file, '{');
      const result = await srv.json('/api/sched/snapshot');
      assert.equal(result.status, 503); assert.equal(result.body.readable, false); assert.equal(result.body.queue, null); assert.ok(result.body.reason);
      fs.writeFileSync(file, original);
    } else {
      fs.renameSync(file, file + '-away');
      const result = await srv.json('/api/sched/snapshot');
      assert.equal(result.status, 503); assert.equal(result.body.error, '读不到调度共享盘'); assert.equal(result.body.queue, null);
      fs.renameSync(file + '-away', file);
    }
  }
  fs.renameSync(srv.paths.tickets, srv.paths.tickets + '-away');
  assert.equal((await srv.json('/api/sched/tickets')).status, 503);
  assert.equal((await srv.json(`/api/sched/ticket/${record.ticketId}`)).status, 503);
});

test('写指令前版本闸：版本更高或格式读不到时不写任何指令与旧预留', async t => {
  const srv = await startServer(t);
  write(srv.paths.format, { formatVersion: 2, capabilities: [], createdAt: AT });
  for (const kind of ['owner-hold', 'reserve']) {
    const result = await srv.json('/api/sched/command', { kind, data: kind === 'reserve' ? { requestedCores: 10 } : {} });
    assert.equal(result.status, 503); assert.match(result.body.error, /格式比本代码新/);
  }
  fs.unlinkSync(srv.paths.format);
  assert.equal((await srv.json('/api/sched/command', { kind: 'reserve', data: { requestedCores: 5 } })).status, 503);
  assert.deepEqual(commandFiles(srv), []); assert.deepEqual(fs.readdirSync(srv.paths.staging), []); assert.deepEqual(fs.readdirSync(srv.legacy), []);
});

test('模块关闭时 sched 所有读写端点均 404；设置文件可提供共享盘位置', async t => {
  const srv = await startServer(t, { modules: '', settingsShare: true });
  for (const endpoint of ['snapshot', 'tickets', `ticket/${ticket(1).ticketId}`]) assert.equal((await srv.json('/api/sched/' + endpoint)).status, 404);
  for (const endpoint of ['command', 'legacy-reserve']) assert.equal((await srv.json('/api/sched/' + endpoint, {})).status, 404);
  assert.deepEqual(commandFiles(srv), []);
  const configured = await startServer(t, { settingsShare: true });
  assert.equal((await configured.json('/api/sched/snapshot')).body.share, configured.share);
});

test('sched:changed 与 board 通道共存：心跳 cursorSeq 和回执目录 mtime 分别触发', async t => {
  const srv = await startServer(t), stream = await openStream(t, srv.base);
  await stream.wait(event => event.name === 'hello');
  const hb = heartbeat(); hb.cursorSeq = 21; write(srv.paths.heartbeat, hb);
  const first = await stream.wait(event => event.name === 'sched:changed' && event.data.cursorSeq === 21);
  assert.deepEqual(first.data, { cursorSeq: 21 });
  hb.cursorSeq = 22; write(srv.paths.heartbeat, hb);
  await stream.wait(event => event.name === 'sched:changed' && event.data.cursorSeq === 22);
  // 用相同序号下的新回执检验目录变化；开第二条订阅排除先前事件的缓存命中。
  const receipts = await openStream(t, srv.base); await receipts.wait(event => event.name === 'hello');
  write(path.join(srv.paths.commandReceipts, 'new-receipt.json'), { commandId: 'new-receipt', status: 'executed', at: AT });
  const mtime = new Date(Date.now() + 2000); fs.utimesSync(srv.paths.commandReceipts, mtime, mtime);
  assert.deepEqual((await receipts.wait(event => event.name === 'sched:changed')).data, { cursorSeq: 22 });
  assert.equal((await srv.json('/api/health')).body.ok, true);
});
