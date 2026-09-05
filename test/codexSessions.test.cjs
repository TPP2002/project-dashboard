'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HEAD_BYTES,
  extractModelAndEffort,
  formatResetLocal,
  inferProjectName,
  isSessionActive,
  isValidSessionId,
  parseSessionIdFromFilename,
  parseTailSnapshot,
  unwrapEvent,
} = require('../server/codexSessionData.cjs');
const {
  aggregateCodexUsage,
  buildCodexReport,
  matchSessionToJob,
  quotaBand,
} = require('../server/codexMetrics.cjs');
const { estimateCodexSavings } = require('../core/costUsage.cjs');
const { buildSessionResumeArgs, listCodexExecutables } = require('../server/codexProcess.cjs');
const { getJobSessionSummary, listSessions } = require('../server/codexSessions.cjs');
const { scanTokenTotalsByDay } = require('../server/codexCostUsage.cjs');

const UUID = '01a05d41-a29f-78f1-bcc6-3ccddd7ec86e';
const NOW = Date.parse('2026-09-01T14:05:00.000Z');

test('从 rollout 文件名提取 UUID，畸形名返回 null', () => {
  assert.equal(parseSessionIdFromFilename(
    `rollout-2026-09-01T21-56-17-${UUID}.jsonl`,
  ), UUID);
  for (const name of ['rollout-bad.jsonl', `${UUID}.jsonl`, 'rollout-2026-09-01-nope.jsonl']) {
    assert.equal(parseSessionIdFromFilename(name), null, name);
  }
});

test('sessionId 只接受 UUID 形状', () => {
  assert.equal(isValidSessionId(UUID), true);
  assert.equal(isValidSessionId('../evil'), false);
  assert.equal(isValidSessionId(''), false);
});

test('会话续聊参数固定为 read-only，且不使用 resume 不支持的参数', () => {
  const args = buildSessionResumeArgs(UUID, '看看结果', 'read-only');
  assert.deepEqual(args, [
    'exec', 'resume', UUID, '看看结果',
    '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
  ]);
  assert.equal(args.includes('--cd'), false);
  assert.equal(args.includes('--sandbox'), false);
});

test('Codex 可执行文件递归过滤后按修改时间取最新', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hashed = path.join(root, 'new-hash');
  const emptyHash = path.join(root, 'rg-only');
  fs.mkdirSync(hashed);
  fs.mkdirSync(emptyHash);
  const oldExe = path.join(root, 'codex.exe');
  const newExe = path.join(hashed, 'codex.exe');
  fs.writeFileSync(oldExe, 'old');
  fs.writeFileSync(newExe, 'new');
  fs.writeFileSync(path.join(emptyHash, 'rg.exe'), 'not codex');
  fs.utimesSync(oldExe, new Date(1_000), new Date(1_000));
  fs.utimesSync(newExe, new Date(2_000), new Date(2_000));
  assert.deepEqual(listCodexExecutables(root).map((item) => item.path), [newExe, oldExe]);
});

test('project 推导兼容主仓、worktree、自身路径、大小写和混合分隔符', () => {
  const projects = {
    rogue: { name: '股市肉鸽(独立游戏·Steam)', mainRepo: 'F:\\stock-rogue' },
    mama: { name: '妈妈方法', mainRepo: 'F:\\mama-method' },
  };
  const dashboard = 'C:\\Users\\Administrator\\.claude\\dashboard';
  assert.equal(inferProjectName('F:\\stock-rogue', projects, dashboard), '股市肉鸽(独立游戏·Steam)');
  assert.equal(inferProjectName('f:/STOCK-ROGUE/.codex\\worktrees/job-x', projects, dashboard), '股市肉鸽(独立游戏·Steam)');
  assert.equal(inferProjectName('c:/USERS/administrator/.claude/dashboard/web', projects, dashboard), '项目管理看板');
  assert.equal(inferProjectName('D:\\unrelated\\repo', projects, dashboard), '其它');
});

test('active 只看最后事件时间戳，阈值内外无需 sleep', () => {
  assert.equal(isSessionActive('2026-09-01T14:03:01.000Z', NOW), true);
  assert.equal(isSessionActive('2026-09-01T14:02:59.000Z', NOW), false);
  assert.equal(isSessionActive(null, NOW), false);
});

test('尾部首行被截断时丢弃半行，并取最后完整事件与累计 token', () => {
  const one = { timestamp: '2026-09-01T14:03:00.000Z', ordinal: 8, type: 'unknown', payload: {} };
  const two = {
    timestamp: '2026-09-01T14:03:57.000Z', ordinal: 9, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 12345 } } },
  };
  const tail = `broken-prefix"}\n${JSON.stringify(one)}\n${JSON.stringify(two)}\n{"timestamp":`;
  const snapshot = parseTailSnapshot(tail, true);
  assert.equal(snapshot.lastActivityAt, two.timestamp);
  assert.equal(snapshot.lastOrdinal, 9);
  assert.equal(snapshot.tokensUsed, 12345);
});

test('response_item 外层包装会暴露 payload.type', () => {
  const wrapped = unwrapEvent({
    type: 'response_item', ordinal: 2,
    payload: { type: 'custom_tool_call', name: 'exec', input: '{"cmd":"npm test"}' },
  });
  assert.equal(wrapped.outerType, 'response_item');
  assert.equal(wrapped.type, 'custom_tool_call');
  assert.equal(wrapped.payload.name, 'exec');
});

test('模型与思考档位只取文件前 256KB', () => {
  const normal = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: UUID } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'max' } }),
  ].join('\n') + '\n';
  assert.deepEqual(extractModelAndEffort(normal), { model: 'gpt-5.6-sol', reasoningEffort: 'max' });

  const filler = JSON.stringify({ type: 'unknown', payload: { text: 'x'.repeat(HEAD_BYTES) } }) + '\n';
  const afterLimit = filler + JSON.stringify({ type: 'turn_context', payload: { model: 'late', reasoning_effort: 'high' } }) + '\n';
  assert.deepEqual(extractModelAndEffort(afterLimit), { model: '未知', reasoningEffort: '未知' });
});

test('新会话继续追加头部事件后，模型缓存会更新', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-head-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = path.join(root, date.slice(0, 4), date.slice(5, 7), date.slice(8, 10));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${date}T00-00-00-${UUID}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    timestamp: now.toISOString(), ordinal: 0, type: 'session_meta',
    payload: { session_id: UUID, timestamp: now.toISOString(), cwd: 'D:\\work' },
  }) + '\n');
  assert.equal(listSessions({ sessionsRoot: root, days: 1 })[0].model, '未知');
  fs.appendFileSync(file, JSON.stringify({
    timestamp: now.toISOString(), ordinal: 1, type: 'turn_context',
    payload: { model: 'gpt-new', effort: 'high' },
  }) + '\n');
  const updated = listSessions({ sessionsRoot: root, days: 1 })[0];
  assert.equal(updated.model, 'gpt-new');
  assert.equal(updated.reasoningEffort, 'high');
});

test('额度解析容忍 secondary=null 与 credits 缺失，并能换算本地时间', () => {
  const event = {
    timestamp: '2026-09-01T14:03:57.000Z', ordinal: 10, type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex', primary: { used_percent: 61, resets_at: 0 }, secondary: null,
    } },
  };
  const snapshot = parseTailSnapshot(JSON.stringify(event) + '\n', false);
  assert.equal(snapshot.quotaSample.rateLimits.secondary, null);
  assert.equal(snapshot.quotaSample.rateLimits.credits, undefined);
  assert.match(formatResetLocal(0, 'Asia/Shanghai'), /1970.*08:00:00/);
});

// ── 详情页只查一个工单自己的会话文件(CODEX-LIVENESS-VERDICT-SPLIT,2026-09-02)──
//
// 战报为了巡检全部工单要扫一遍时间窗内的全部会话,列表接口付不起这个代价所以故意不查;
// 但详情页每次只看一个工单,查它自己那一份文件不该有这个顾虑——这个函数就是那条"只查一个"的路径。

test('getJobSessionSummary 按 threadId 只读一个会话文件，查不到时返回 null', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-single-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = path.join(root, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(day, { recursive: true });
  const id = '22222222-2222-2222-2222-222222222222';
  const activityAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(day, `rollout-2026-01-01T00-00-00-${id}.jsonl`), JSON.stringify({
    timestamp: activityAt, ordinal: 0, type: 'session_meta',
    payload: { session_id: id, timestamp: activityAt, cwd: 'D:\\work' },
  }) + '\n');

  const summary = getJobSessionSummary(id, { sessionsRoot: root });
  assert.equal(summary.sessionId, id);
  assert.equal(summary.lastActivityAt, activityAt);

  assert.equal(getJobSessionSummary(null, { sessionsRoot: root }), null, '没有 threadId 时不查文件、直接返回 null');
  assert.equal(getJobSessionSummary('not-found-id', { sessionsRoot: root }), null, '查不到匹配文件时返回 null');
});

test('额度分档边界为 94ok、95停派、98提醒重置、99接手，与 codex-brief.cjs 同口径', () => {
  assert.equal(quotaBand(94).code, 'ok');
  assert.equal(quotaBand(95).code, 'stop-dispatch');
  assert.equal(quotaBand(97).code, 'stop-dispatch');
  assert.equal(quotaBand(98).code, 'remind-reset');
  assert.equal(quotaBand(99).code, 'handover');
  assert.equal(quotaBand(100).code, 'handover');
  assert.equal(quotaBand(NaN).code, 'unknown');
  assert.match(quotaBand(99).label, /剩 ≤1%/);
  assert.match(quotaBand(98).label, /剩 ≤2%/);
  assert.match(quotaBand(95).label, /剩 ≤5%/);
});

test('工单与会话按 threadId 匹配，匹配不上返回 null', () => {
  const jobs = [{ slug: 'job-one', title: '第一单', threadId: UUID }];
  assert.deepEqual(matchSessionToJob(UUID, jobs), { slug: 'job-one', title: '第一单' });
  assert.equal(matchSessionToJob('11111111-1111-1111-1111-111111111111', jobs), null);
});

test('战报只统计窗口内；空数据全部为 0', () => {
  const jobs = [
    { slug: 'in-pass', title: '通过', dispatchedAt: '2026-09-01T13:00:00Z', running: false, collected: true, passed: true },
    { slug: 'in-reject', title: '驳回', dispatchedAt: '2026-09-01T12:00:00Z', running: false, collected: true, passed: false, rejectionReason: 'A1 未通过' },
    { slug: 'old', title: '旧单', dispatchedAt: '2026-08-30T12:00:00Z', running: true, collected: false, passed: null },
  ];
  const sessions = [
    { startedAt: '2026-09-01T13:30:00Z', lastActivityAt: '2026-09-01T14:04:00Z', tokensUsed: 100 },
    { startedAt: '2026-08-30T13:30:00Z', lastActivityAt: '2026-08-30T14:04:00Z', tokensUsed: 999 },
  ];
  const report = buildCodexReport({ jobs, sessions, nowMs: NOW, windowMs: 24 * 60 * 60 * 1000, quotaUsedPercent: 61 });
  assert.deepEqual(
    { dispatched: report.dispatched, passed: report.passed, rejected: report.rejected, running: report.running, tokensUsed: report.tokensUsed },
    { dispatched: 2, passed: 1, rejected: 1, running: 0, tokensUsed: 100 },
  );
  assert.equal(report.rejectedJobs[0].reason, 'A1 未通过');

  const empty = buildCodexReport({ jobs: [], sessions: [], nowMs: NOW, windowMs: 1, quotaUsedPercent: null });
  assert.deepEqual(
    { dispatched: empty.dispatched, passed: empty.passed, rejected: empty.rejected, running: empty.running, tokensUsed: empty.tokensUsed },
    { dispatched: 0, passed: 0, rejected: 0, running: 0, tokensUsed: 0 },
  );
});

test('Codex 用量按天和项目聚合', () => {
  const usage = aggregateCodexUsage([
    { startedAt: '2026-09-01T01:00:00Z', project: '甲', tokensUsed: 10 },
    { startedAt: '2026-09-01T02:00:00Z', project: '乙', tokensUsed: 20 },
  ], { days: 7, nowMs: NOW, projectName: '甲' });
  assert.equal(usage.totals.tokens, 30);
  assert.equal(usage.selected.tokens, 10);
  assert.deepEqual(usage.byDay[0].projects, { '甲': 10, '乙': 20 });

  const crossDay = aggregateCodexUsage([
    { project: '甲', dailyTokens: { '2026-09-01': 15, '2026-09-02': 25 } },
  ], { days: 7, nowMs: new Date(2026, 8, 2, 12).getTime(), projectName: '甲' });
  assert.deepEqual(crossDay.byDay.map((day) => [day.date, day.tokens]), [
    ['2026-09-01', 15], ['2026-09-02', 25],
  ]);
  assert.equal(crossDay.totals.tokens, 40);
});

test('跨日 token_count 流式按累计增量拆日，并兼容外层包装', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-days-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const tokenEvent = (timestamp, ordinal, total) => JSON.stringify({
    timestamp, ordinal, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
  });
  fs.writeFileSync(file, [
    tokenEvent('2026-09-01T10:00:00', 1, 100),
    tokenEvent('2026-09-01T11:00:00', 2, 150),
    JSON.stringify({ timestamp: '2026-09-01T12:00:00', ordinal: 3, type: 'response_item', payload: { type: 'reasoning' } }),
    tokenEvent('2026-09-02T01:00:00', 4, 200),
    tokenEvent('2026-09-02T02:00:00', 5, 20),
  ].join('\n') + '\n');
  assert.deepEqual(await scanTokenTotalsByDay(file), {
    dailyTokens: { '2026-09-01': 150, '2026-09-02': 70 },
    tokensUsed: 220,
  });
});

test('Claude 同期数据为空时粗估返回 null，不产生 NaN 或 Infinity', () => {
  assert.equal(estimateCodexSavings(1000, { totals: {}, usd: { actual: 0 } }), null);
  assert.equal(estimateCodexSavings(1000, null), null);
  assert.equal(estimateCodexSavings(1000, {
    totals: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
    usd: { actual: 2 },
  }), 10);
});
