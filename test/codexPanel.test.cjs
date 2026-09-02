'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  EXEC_TAIL_MAX_BYTES, getJobDetail, isRedispatchBlocked, isValidSlug, mergeAcceptanceResults,
  parseTaskJson, readTailLines, summarizeJob,
} = require('../server/codexJobs.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(DASH_ROOT, 'server', 'server.cjs');
let fixture;

function files(overrides = {}) {
  return {
    slug: 'job-one',
    task: { title: '第一单', taskId: 'CARD-1', acceptance: [{ id: 'A1', required: true }] },
    meta: { dispatchedAt: '2026-09-01T01:00:00.000Z' },
    state: { finishedAt: null, exitCode: null },
    verdict: null,
    verdictExists: false,
    ...overrides,
  };
}

test('slug 只接受小写字母、数字和连字符', () => {
  for (const slug of ['../evil', 'a/b', '', 'Upper']) assert.equal(isValidSlug(slug), false, slug);
  for (const slug of ['a', 'job-123', '123']) assert.equal(isValidSlug(slug), true, slug);
});

test('复派时工单仍在跑或已有派单进程就拒绝', () => {
  assert.equal(isRedispatchBlocked({ finishedAt: null }, false), true);
  assert.equal(isRedispatchBlocked({ finishedAt: '2026-09-01T02:00:00Z' }, true), true);
  assert.equal(isRedispatchBlocked({ finishedAt: '2026-09-01T02:00:00Z' }, false), false);
});

test('改了再派只接受顶层为对象的合法 JSON', () => {
  assert.deepEqual(parseTaskJson('{"title":"重派"}'), { title: '重派' });
  assert.throws(() => parseTaskJson('{broken'), /工单 JSON 不合法/);
  assert.throws(() => parseTaskJson('[]'), /顶层必须是对象/);
});

test('summarizeJob 推导四种工单状态', async (t) => {
  await t.test('running', () => {
    const job = summarizeJob(files());
    assert.deepEqual([job.running, job.collected, job.passed], [true, false, null]);
  });
  await t.test('跑完没收', () => {
    const job = summarizeJob(files({ state: { finishedAt: '2026-09-01T02:00:00Z', exitCode: 0 } }));
    assert.deepEqual([job.running, job.collected, job.passed], [false, false, null]);
  });
  await t.test('过了（可选项失败不影响）', () => {
    const task = { title: '通过', taskId: 'CARD-1', acceptance: [
      { id: 'A1', required: true }, { id: 'M1', required: false },
    ] };
    const verdict = { acceptance: [
      { id: 'A1', required: true, passed: true }, { id: 'M1', required: false, passed: false },
    ] };
    const job = summarizeJob(files({ task, state: { finishedAt: 'done', exitCode: 0 }, verdict, verdictExists: true }));
    assert.deepEqual([job.running, job.collected, job.passed], [false, true, true]);
  });
  await t.test('驳回', () => {
    const verdict = { acceptance: [{ id: 'A1', required: true, passed: false }] };
    const job = summarizeJob(files({ state: { finishedAt: 'done', exitCode: 1 }, verdict, verdictExists: true }));
    assert.deepEqual([job.running, job.collected, job.passed], [false, true, false]);
  });
});

test('exec.jsonl 只返回最后 80 行原始文本', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'exec.jsonl');
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`);
  fs.writeFileSync(log, lines.join('\r\n') + '\r\n');
  assert.equal(readTailLines(log), lines.slice(20).join('\r\n') + '\r\n');
});

test('exec.jsonl 尾读有字节上限，并丢掉截断的首行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'exec.jsonl');
  fs.writeFileSync(log, 'x'.repeat(EXEC_TAIL_MAX_BYTES + 100) + '\nlast\n');
  assert.equal(readTailLines(log), 'last\n');
});

test('工单声明里的验收 kind 会按编号合并进判决结果', () => {
  const task = { acceptance: [
    { id: 'A1', kind: 'test:targeted', target: 'test/one.test.cjs', required: true },
    { id: 'A2', kind: 'typecheck', required: true },
  ] };
  const verdict = { acceptance: [
    { id: 'A1', required: true, passed: true, exitCode: 0 },
    { id: 'A2', required: true, passed: false, exitCode: 2 },
  ] };
  assert.deepEqual(mergeAcceptanceResults(task, verdict), [
    { id: 'A1', kind: 'test:targeted', target: 'test/one.test.cjs', required: true, passed: true, exitCode: 0 },
    { id: 'A2', kind: 'typecheck', required: true, passed: false, exitCode: 2 },
  ]);
});

test('工单详情读取大白话总结，并允许初次加载跳过日志尾部', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plain-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'plain-job');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    title: '让负责人看懂结果', goal: '把工单结果改成人能直接看懂的话。',
    acceptance: [{ id: 'A1', kind: 'test:fast', required: true }],
  }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ finishedAt: 'done', exitCode: 0 }));
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({
    plainSummary: '这个面板已经改好，负责人打开就能看懂结果。',
    acceptance: [{ id: 'A1', required: true, passed: true, exitCode: 0 }],
    selfReport: { status: 'completed', summary: '技术说明' },
  }));
  fs.writeFileSync(path.join(dir, 'exec.jsonl'), '不应在初次加载时读取\n最后一行\n');

  const initial = getJobDetail(root, 'plain-job', { includeTail: false });
  assert.equal(initial.goal, '把工单结果改成人能直接看懂的话。');
  assert.equal(initial.plainSummary, '这个面板已经改好，负责人打开就能看懂结果。');
  assert.equal(initial.acceptance[0].kind, 'test:fast');
  assert.equal(initial.tail, '');
  assert.equal(getJobDetail(root, 'plain-job', { includeTail: true }).tail, '不应在初次加载时读取\n最后一行\n');
});

test('前端把验收、自述与四类工单状态翻译成人话', async () => {
  const moduleUrl = pathToFileURL(path.join(
    DASH_ROOT, 'web', 'src', 'components', 'codex', 'jobPresentation.js',
  )).href;
  const presentation = await import(moduleUrl);
  assert.equal(presentation.acceptanceLabel({ kind: 'test:targeted', id: 'A1' }), '跑了指定的那部分测试');
  assert.equal(presentation.acceptanceLabel({ kind: 'test:fast', id: 'A2' }), '跑了全部测试');
  assert.equal(presentation.acceptanceLabel({ kind: 'typecheck', id: 'A3' }), '检查代码有没有写错类型');
  assert.equal(presentation.acceptanceLabel({ kind: 'lint', id: 'A4' }), '检查代码/文案格式');
  assert.equal(presentation.acceptanceLabel({ kind: 'lint:content', id: 'A5' }), '检查代码/文案格式');
  assert.equal(presentation.acceptanceLabel({ kind: 'docs:index:check', id: 'A6' }), '检查文档目录对不对得上');
  assert.equal(presentation.acceptanceLabel({ kind: 'manual', id: 'A7' }), '需要人工核对(机器没法自动查)');
  assert.equal(presentation.acceptanceLabel({ kind: 'future:check', id: 'A8' }), 'future:check');
  assert.equal(presentation.selfReportStatusLabel('completed'), '它说做完了');
  assert.equal(presentation.selfReportStatusLabel('partial'), '它说只做了一部分');
  assert.equal(presentation.selfReportStatusLabel('failed'), '它说没做成');
  assert.equal(presentation.jobGroupKey({ running: true, collected: false, passed: null }), 'running');
  assert.equal(presentation.jobGroupKey({ running: false, collected: false, passed: null }), 'waiting');
  assert.equal(presentation.jobGroupKey({ running: false, collected: true, passed: false }), 'rejected');
  assert.equal(presentation.jobGroupKey({ running: false, collected: true, passed: true }), 'completed');
  // 失联必须排在 running 之前判:这种单的 running 也是 true,先判 running 会把尸体混进「还在干」
  assert.equal(presentation.jobGroupKey({ running: true, collected: false, passed: null, liveness: 'stalled' }), 'stalled');
  assert.equal(presentation.jobGroupKey({ running: true, collected: false, passed: null, liveness: 'running' }), 'running');
});

test('工单目录存在但内部文件全缺时详情使用空值而不报错', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'empty-job'));
  assert.deepEqual(getJobDetail(root, 'empty-job'), {
    slug: 'empty-job', title: 'empty-job', taskId: null, dispatchedAt: null,
    running: true, collected: false, passed: null, exitCode: null,
    // 三个原始事实字段供 codexJobHealth.cjs 判三态用(CODEX-DEAD-SESSION-DETECT);
    // 全缺时仍是 null,断言强度不变,照旧是逐字段精确比对。
    pid: null, startedAt: null, timeoutSec: null,
    goal: null, acceptance: [], plainSummary: null, selfReport: null, chat: [], tail: '',
  });
});

function startServer(registry, sessionsRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: DASH_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        DASHBOARD_NO_OPEN: '1',
        DASHBOARD_REGISTRY: registry,
        DASHBOARD_CODEX_SESSIONS: sessionsRoot,
        DASHBOARD_PORT: String(30000 + Math.floor(Math.random() * 20000)),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server 启动超时\n${stdout}\n${stderr}`)), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server 提前退出 ${code}\n${stdout}\n${stderr}`)));
  });
}

before(async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-api-')));
  const repo = path.join(dir, 'rogue');
  const sessions = path.join(dir, 'sessions');
  const registry = path.join(dir, 'registry.json');
  fs.mkdirSync(repo, { recursive: true });
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const dayNumber = pad(now.getDate());
  const day = path.join(sessions, year, month, dayNumber);
  fs.mkdirSync(day, { recursive: true });
  const sessionId = '01a05d41-a29f-78f1-bcc6-3ccddd7ec86e';
  const fileTime = `${year}-${month}-${dayNumber}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const timestamps = [4, 3, 2, 1].map((seconds) => new Date(now.getTime() - seconds * 1000).toISOString());
  fs.writeFileSync(path.join(day, `rollout-${fileTime}-${sessionId}.jsonl`), [
    JSON.stringify({ timestamp: timestamps[0], ordinal: 0, type: 'session_meta', payload: {
      session_id: sessionId, timestamp: timestamps[0], cwd: repo,
      originator: 'codex_exec', cli_version: 'test',
    } }),
    JSON.stringify({ timestamp: timestamps[1], ordinal: 1, type: 'turn_context', payload: {
      model: 'gpt-test', reasoning_effort: 'high',
    } }),
    JSON.stringify({ timestamp: timestamps[2], ordinal: 2, type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }],
    } }),
    JSON.stringify({ timestamp: timestamps[3], ordinal: 3, type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { total_tokens: 321 } },
      rate_limits: { primary: { used_percent: 59, resets_at: 0 }, secondary: null },
    } }),
  ].join('\n') + '\n');
  fs.writeFileSync(registry, JSON.stringify({
    schemaVersion: '1.0',
    projects: { rogue: { name: '测试项目', mainRepo: repo, board: path.join(repo, '.dashboard', 'board.json') } },
  }));
  fixture = { dir, repo, sessionId, ...(await startServer(registry, sessions)) };
});

after(async () => {
  if (!fixture) return;
  if (fixture.child.exitCode === null) {
    fixture.child.kill();
    await new Promise((resolve) => fixture.child.once('exit', resolve));
  }
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

test('工单目录不存在时 GET /api/codex/jobs 返回空数组', async () => {
  const response = await fetch(fixture.base + '/api/codex/jobs');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test('GET /api/codex/job?tail=0 不返回日志，展开请求才返回', async () => {
  const dir = path.join(fixture.repo, '.codex', 'jobs', 'detail-job');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    title: '详情测试', goal: '让人看懂', acceptance: [{ id: 'A1', kind: 'typecheck', required: true }],
  }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ finishedAt: 'done', exitCode: 0 }));
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({
    plainSummary: '已经完成。', acceptance: [{ id: 'A1', required: true, passed: true, exitCode: 0 }],
  }));
  fs.writeFileSync(path.join(dir, 'exec.jsonl'), 'only-when-open\n');

  const folded = await (await fetch(fixture.base + '/api/codex/job?slug=detail-job&tail=0')).json();
  assert.equal(folded.tail, '');
  assert.equal(folded.plainSummary, '已经完成。');
  assert.equal(folded.acceptance[0].kind, 'typecheck');
  const opened = await (await fetch(fixture.base + '/api/codex/job?slug=detail-job&tail=1')).json();
  assert.equal(opened.tail, 'only-when-open\n');
});

test('GET /api/codex/job 拒绝四种非法 slug', async () => {
  for (const slug of ['../evil', 'a/b', '', 'Upper']) {
    const response = await fetch(fixture.base + '/api/codex/job?slug=' + encodeURIComponent(slug));
    assert.equal(response.status, 400, slug);
  }
});

test('三条写 API 都在启动子进程前拒绝非法 slug', async () => {
  for (const endpoint of ['say', 'dispatch', 'collect']) {
    const response = await fetch(fixture.base + '/api/codex/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: '../evil', message: 'hello' }),
    });
    assert.equal(response.status, 400, endpoint);
  }
});

test('say 拒绝空白消息和超过 8000 字符的消息', async () => {
  for (const message of ['   ', 'x'.repeat(8001)]) {
    const response = await fetch(fixture.base + '/api/codex/say', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'job-one', message }),
    });
    assert.equal(response.status, 400);
  }
});

test('会话、详情、额度与成本 API 返回同一份有界扫描结果', async () => {
  const listResponse = await fetch(fixture.base + '/api/codex/sessions?limit=5');
  assert.equal(listResponse.status, 200);
  const sessions = await listResponse.json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tokensUsed, 321);
  assert.equal(sessions[0].model, 'gpt-test');

  const detailResponse = await fetch(fixture.base + '/api/codex/session?id=' + fixture.sessionId + '&tail=5');
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.events.find((event) => event.type === 'message').text, '完成');

  const quotaResponse = await fetch(fixture.base + '/api/codex/quota');
  assert.equal(quotaResponse.status, 200);
  assert.equal((await quotaResponse.json()).usedPercent, 59);

  const costResponse = await fetch(fixture.base + '/api/cost?project=rogue&days=7');
  assert.equal(costResponse.status, 200);
  const cost = await costResponse.json();
  assert.equal(cost.ok, true);
  assert.deepEqual(cost.combined, {
    claudeTokens: 0, codexTokens: 321, totalTokens: 321, savingsEstimateUsd: null,
  });
});
