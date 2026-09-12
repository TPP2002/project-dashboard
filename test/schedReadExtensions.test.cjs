'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const c = require('../core/schedContract.cjs');
const { ticketCsv } = require('../core/schedCsv.cjs');
const { readLedger } = require('../core/schedLedger.cjs');
const { createSchedApi } = require('../server/schedApi.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');
const NOW = Date.parse(AT) + 3600000;

async function apiFixture(t) {
  let server;
  const share = temporary(t, async () => {
    if (!server) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const paths = initialize(share), ledger = path.join(paths.root, 'ledger'); fs.mkdirSync(ledger);
  const beat = c.readJson(paths.heartbeat); beat.at = new Date(NOW).toISOString();
  for (const machine of beat.machines) { machine.heartbeatAt = beat.at; machine.loadSampledAt = beat.at; }
  write(paths.heartbeat, beat);
  const api = createSchedApi({ resolveShare: () => share, sources: { now: () => NOW, nonce: () => 'fixture-nonce' },
    cpuBudget: { cpuStatus: () => ({ reservedCores: 0, reserveExpiresAt: null }) }, bodyMax: 1024,
    readBody: () => { throw new Error('只读验收不应读取指令请求体'); },
    sendJson: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!api.route(url.pathname.slice('/api/sched/'.length), req, res, Object.fromEntries(url.searchParams))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/sched/`;
  const save = value => write(path.join(paths.tickets, `${value.ticketId}.json`), value);
  const ledgerFile = path.join(ledger, '2026-09-12.jsonl');
  function events(values) {
    fs.writeFileSync(ledgerFile, values.map((value, index) => {
      const body = { v: 1, seq: index + 1, at: AT, ...value };
      return JSON.stringify({ ...body, sha256: c.contentHash(body) });
    }).join('\n') + (values.length ? '\n' : ''));
  }
  const get = endpoint => fetch(base + endpoint);
  const json = async endpoint => { const response = await get(endpoint); return { status: response.status, body: await response.json() }; };
  return { share, paths, ledger, ledgerFile, save, events, get, json };
}

// 独立解析带引号、双引号转义与跨行字段，按 Excel 所读的单元格核对导出。
function csvRows(text) {
  const rows = [], row = []; let value = '', quoted = false;
  for (let index = text.charCodeAt(0) === 0xFEFF ? 1 : 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r' || char === '\n')) {
      row.push(value); value = '';
      if (char !== ',') { rows.push([...row]); row.length = 0; if (char === '\r' && text[index + 1] === '\n') index++; }
    } else value += char;
  }
  assert.equal(quoted, false); return rows;
}

test('服务端 CSV 带 BOM、固定十五列，与全部筛选结果一致，忽略分页游标', async t => {
  const api = await apiFixture(t);
  const records = [ticket(1), ticket(2), ticket(3, { project: 'fixture-alternative', state: 'failed', submitter: 'fixture-other', machine: 'fixture-host' })];
  records.forEach(api.save);
  for (const query of ['', 'project=sample', 'project=missing', 'machine=fixture-host', 'submitter=fixture-other', 'result=failed',
    'from=2026-09-13', 'to=2026-09-11', 'project=fixture-alternative&machine=fixture-host&submitter=fixture-other&result=failed&from=2026-09-12&to=2026-09-12']) {
    const page = await api.json(`tickets?${query}`), response = await api.get(`tickets.csv?${query}&limit=1&cursor=unused`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/csv.*utf-8/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    const rows = csvRows(bytes.toString('utf8'));
    assert.deepEqual(rows[0], ['单号', '项目', '派单方', '类别', '作业', '机器', '申请核', '授予核', '状态', '结果', '挂号时刻', '开跑时刻', '结束时刻', '耗时', '原因']);
    assert.deepEqual(rows.slice(1).map(row => row[0]), page.body.items.map(item => item.ticketId));
    assert.ok(rows.every(row => row.length === 15));
    if (!query) assert.deepEqual(rows[1], [records[2].ticketId, 'fixture-alternative', 'fixture-other', 'unit-test', 'test', 'fixture-host', '4', '4',
      'failed', 'failed', records[2].createdAt, records[2].attempts[0].startedAt, records[2].endedAt, '2000', 'fixture result']);
  }
  for (const query of ['result=bogus', 'from=2026-02-30', 'from=2026-09-13&to=2026-09-12']) assert.equal((await api.get(`tickets.csv?${query}`)).status, 400);
  assert.deepEqual(fs.readdirSync(api.paths.commands), ['_receipts']);
});

test('CSV 正确保留逗号换行引号、防止公式执行，恰好一万行可导出，超出明确拒绝', () => {
  const value = ticket(1); value.request.project = 'fixture,"project"\nsecond-line'; value.request.submitter = '=1+1';
  value.attempts[0].result.reason = 'line1\r\nline2,"quoted"';
  const rows = csvRows(ticketCsv([value]));
  assert.equal(rows[1][1], value.request.project); assert.equal(rows[1][2], "'=1+1"); assert.equal(rows[1][14], value.attempts[0].result.reason);
  assert.equal(csvRows(ticketCsv(Array(10000).fill(value))).length, 10001);
  assert.throws(() => ticketCsv(Array(10001).fill(value)), error => error.status === 413 && /收紧筛选/.test(error.message));
});

test('机器负载原样取 externalLoadCores，接入项目从台账去重，原始心跳不加计算字段', async t => {
  const api = await apiFixture(t), record = ticket(1); record.request.project = 'fixture-from-ledger'; api.save(record);
  api.events([{ type: 'submitted', ticketId: record.ticketId, attemptId: 'a1', data: { request: record.request } },
    { type: 'started', ticketId: record.ticketId, attemptId: 'a1', data: {} }]);
  const heartbeat = c.readJson(api.paths.heartbeat), result = await api.json('snapshot');
  assert.equal(result.status, 200); assert.deepEqual(result.body.machines, heartbeat.machines);
  assert.equal(result.body.machines[0].externalLoadCores, 1.25); assert.equal(result.body.machines[0].availableCores, 2.75);
  assert.deepEqual(result.body.connectedProjects, { readable: true, names: ['fixture-from-ledger'], reason: null });
  assert.deepEqual(result.body.dispatcher.heartbeat, heartbeat);
});

test('详情原始快照不变，交接节点按执行号对应，父单列出子单且子单保留父号', async t => {
  const api = await apiFixture(t), parent = ticket(1), child = ticket(2); child.request.parentTicketId = parent.ticketId;
  api.save(parent); api.save(child);
  const intentAt = new Date(NOW - 2000).toISOString(), dispatchedAt = new Date(NOW - 1000).toISOString();
  api.events([{ type: 'dispatch-intent', at: intentAt, ticketId: parent.ticketId, attemptId: 'a1', data: { intent: { machine: 'fixture-worker', submissionId: 'fixture-first' } } },
    { type: 'dispatched', at: dispatchedAt, ticketId: parent.ticketId, attemptId: 'a1', data: { submissionId: 'fixture-first' } },
    { type: 'dispatch-intent', at: new Date(NOW).toISOString(), ticketId: parent.ticketId, attemptId: 'a2', data: { intent: { machine: 'fixture-worker', submissionId: 'fixture-second' } } }]);
  const result = await api.json(`ticket/${parent.ticketId}`);
  assert.deepEqual(result.body.ticket, parent); assert.deepEqual(result.body.related.children, [{ ticketId: child.ticketId, title: child.request.title, state: child.state }]);
  assert.deepEqual(result.body.related.handoffs, [{ attemptId: 'a1', intentAt, dispatchedAt, machine: 'fixture-worker', submissionId: 'fixture-first' },
    { attemptId: 'a2', intentAt: new Date(NOW).toISOString(), dispatchedAt: null, machine: 'fixture-worker', submissionId: 'fixture-second' }]);
  assert.equal((await api.json(`ticket/${child.ticketId}`)).body.ticket.request.parentTicketId, parent.ticketId);
  assert.equal(Object.hasOwn((await api.json(`ticket/${parent.ticketId}?related=0`)).body, 'related'), false);
});

test('台账缺失或坏行只降级新信息，共享盘失联时快照、导出和详情都明确报不可读', async t => {
  const api = await apiFixture(t), record = ticket(1, { state: 'running' }); api.save(record);
  fs.writeFileSync(api.ledgerFile, '{');
  let result = await api.json('snapshot');
  assert.equal(result.status, 200); assert.equal(result.body.connectedProjects.readable, false);
  assert.equal(result.body.estimates[record.ticketId].code, 'ledger'); assert.match(result.body.historyError, /读不到/);
  assert.equal((await api.json(`ticket/${record.ticketId}`)).body.related.readable, false);
  fs.unlinkSync(api.ledgerFile); fs.rmdirSync(api.ledger);
  assert.equal(readLedger(api.share).readable, false);
  assert.equal((await api.json('snapshot')).body.connectedProjects.readable, false);
  fs.renameSync(api.paths.tickets, api.paths.tickets + '-away');
  result = await api.json('snapshot');
  assert.equal(result.status, 503); assert.equal(result.body.estimates, null); assert.equal(result.body.connectedProjects, null);
  assert.equal((await api.get('tickets.csv')).status, 503);
  assert.equal((await api.json(`ticket/${record.ticketId}`)).status, 503);
});

test('台账校验和损坏不会成为执行样本，读取过程不修盘、不截断尾行', async t => {
  const api = await apiFixture(t), record = ticket(1);
  api.events([{ type: 'submitted', ticketId: record.ticketId, attemptId: 'a1', data: { request: record.request } }]);
  const event = JSON.parse(fs.readFileSync(api.ledgerFile, 'utf8')); event.sha256 = '0'.repeat(64);
  const bytes = JSON.stringify(event) + '\n'; fs.writeFileSync(api.ledgerFile, bytes);
  const result = readLedger(api.share); assert.equal(result.readable, false); assert.match(result.reason, /校验和/);
  assert.equal(fs.readFileSync(api.ledgerFile, 'utf8'), bytes);
});
