'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanProject, KINDS } = require('../core/reconcileScan.cjs');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const H = 3600000;
const D = 24 * H;
const ago = (ms) => new Date(NOW - ms).toISOString();

const card = (over = {}) => ({ id: 'FEAT-1', plainTitle: '示例卡', status: '施工中', prNumbers: [], gitBranch: [], ...over });
const job = (over = {}) => ({
  slug: 'feat-x', taskId: 'FEAT-1', branch: 'codex/feat-x', landed: false, pushed: false, landBranch: null,
  finishedAt: null, startedAt: null, pid: null, verdict: null, worktreeExists: false, dispatched: true, autoLandPr: null, ...over,
});
const input = (over = {}) => ({
  projectId: 'myproj', board: { tasks: [card()], activity: [] }, now: NOW, staleDays: 2, collectHours: 6,
  exempt: new Set(),
  prs: { available: true, open: [], merged: [] },
  branches: { available: true, remote: new Map(), isAncestor: () => false },
  jobs: [], ...over,
});
const kinds = (res) => res.findings.map((f) => f.kind);

test('KINDS 有六类', () => {
  assert.deepEqual(Object.keys(KINDS).length, 6);
});

// ---- R1 ALL_LANDED ----
const r1 = (over = {}) => input({
  board: { tasks: [card({ lastProgressAt: ago(H) })], activity: [] },
  jobs: [job({ slug: 'a', branch: 'codex/a', landed: true }), job({ slug: 'b', branch: 'codex/b', landed: true })],
  prs: { available: true, open: [], merged: [{ number: 5, title: 'x', headRefName: 'codex/a', mergedAt: ago(D) }] },
  branches: { available: true, remote: new Map(), isAncestor: (b) => b === 'codex/b' },
  ...over,
});
test('R1 两张单都进主干 → ALL_LANDED', () => {
  const res = scanProject(r1());
  assert.deepEqual(kinds(res), ['ALL_LANDED']);
  assert.equal(res.findings[0].key, 'ALL_LANDED:FEAT-1:');
  assert.match(res.findings[0].detail, /2 张单都已合进主干/);
});
test('R1 有开着的 PR → 不命中', () => {
  const base = r1();
  base.prs.open = [{ number: 9, title: 'FEAT-1: more', headRefName: 'codex/more', updatedAt: ago(H) }];
  assert.deepEqual(kinds(scanProject(base)), []);
});
test('R1 有未派的契约 → 不命中', () => {
  const base = r1();
  base.jobs.push(job({ slug: 'c', branch: null, dispatched: false }));
  assert.deepEqual(kinds(scanProject(base)), []);
});
test('R1 prs 不可用 → 不命中', () => {
  const base = r1();
  base.prs = { available: false, open: [], merged: [] };
  assert.deepEqual(kinds(scanProject(base)), []);
});

// ---- R2 LANDED_NO_PR ----
const r2 = (over = {}) => input({
  board: { tasks: [card({ status: '收官' })], activity: [] },
  jobs: [job({ landed: true, pushed: true })],
  branches: { available: true, remote: new Map([['codex/feat-x', ago(D)]]), isAncestor: () => false },
  ...over,
});
test('R2 推了分支没开 PR → LANDED_NO_PR', () => {
  const res = scanProject(r2());
  assert.deepEqual(kinds(res), ['LANDED_NO_PR']);
  assert.equal(res.findings[0].key, 'LANDED_NO_PR:FEAT-1:feat-x');
});
test('R2 有同分支已合并 PR → 不命中', () => {
  const res = scanProject(r2({ prs: { available: true, open: [], merged: [{ number: 3, title: 't', headRefName: 'codex/feat-x', mergedAt: ago(D) }] } }));
  assert.ok(!kinds(res).includes('LANDED_NO_PR'));
});
test('R2 isAncestor=true → 不命中', () => {
  const res = scanProject(r2({ branches: { available: true, remote: new Map([['codex/feat-x', ago(D)]]), isAncestor: () => true } }));
  assert.ok(!kinds(res).includes('LANDED_NO_PR'));
});

// ---- R3 AWAIT_COLLECT ----
const r3 = (finishedAgo, over = {}) => input({
  board: { tasks: [card({ status: '待收单', lastProgressAt: ago(H) })], activity: [] },
  jobs: [job({ finishedAt: ago(finishedAgo), worktreeExists: true, ...over })],
});
test('R3 10 小时前交活 → AWAIT_COLLECT', () => {
  const res = scanProject(r3(10 * H));
  assert.deepEqual(kinds(res), ['AWAIT_COLLECT']);
  assert.match(res.findings[0].detail, /单 feat-x .* 交活,到现在没人收/);
});
test('R3 1 小时前 → 不命中', () => assert.deepEqual(kinds(scanProject(r3(H))), []));
test('R3 verdict=rejected → 不命中', () => assert.deepEqual(kinds(scanProject(r3(10 * H, { verdict: 'rejected' }))), []));

// ---- R4 FORK_PENDING ----
test('R4 blocked 10 小时前 → FORK_PENDING', () => {
  const res = scanProject(input({
    board: { tasks: [card({ lastProgressAt: ago(H) })], activity: [] },
    jobs: [job({ verdict: 'blocked', worktreeExists: true, finishedAt: ago(10 * H) })],
  }));
  assert.deepEqual(kinds(res), ['FORK_PENDING']);
});
test('R4 blocked 1 小时前 → 不命中', () => {
  const res = scanProject(input({
    board: { tasks: [card({ lastProgressAt: ago(H) })], activity: [] },
    jobs: [job({ verdict: 'blocked', worktreeExists: true, finishedAt: ago(H) })],
  }));
  assert.deepEqual(kinds(res), []);
});

// ---- R5 STALE_IN_PROGRESS ----
const act = (over) => ({ ts: ago(3 * D), type: 'note', taskId: 'FEAT-1', author: 'someone', text: 'x', ...over });
const r5 = (over = {}, task = {}) => input({
  board: { tasks: [card(task)], activity: [act()] }, ...over,
});
test('R5 三天没动静 → STALE_IN_PROGRESS', () => {
  const res = scanProject(r5());
  assert.deepEqual(kinds(res), ['STALE_IN_PROGRESS']);
  assert.match(res.findings[0].detail, /3 天没有动静/);
});
test('R5 只有 reconcile 自己的新留言 → 仍命中', () => {
  const res = scanProject(r5({ board: { tasks: [card()], activity: [act(), act({ ts: ago(H), author: 'reconcile' })] } }));
  assert.deepEqual(kinds(res), ['STALE_IN_PROGRESS']);
});
test('R5 登记的分支一天前有提交 → 不命中', () => {
  const res = scanProject(r5({
    board: { tasks: [card({ gitBranch: ['codex/feat-1'] })], activity: [act()] },
    branches: { available: true, remote: new Map([['codex/feat-1', ago(D)]]), isAncestor: () => false },
  }));
  assert.deepEqual(kinds(res), []);
});
test('R5 待开工 → 不命中', () => assert.deepEqual(kinds(scanProject(r5({}, { status: '待开工' }))), []));
test('R5 在 exempt 里 → 不命中', () => assert.deepEqual(kinds(scanProject(r5({ exempt: new Set(['FEAT-1']) }))), []));

// ---- R6 CLOSED_WITH_OPEN_PR ----
test('R6 暂缓卡有标题以卡号加冒号开头的开着的 PR → CLOSED_WITH_OPEN_PR', () => {
  const res = scanProject(input({
    board: { tasks: [card({ status: '暂缓' })], activity: [] },
    prs: { available: true, open: [{ number: 12, title: 'FEAT-1: 做点事', headRefName: 'codex/zzz', updatedAt: ago(H) }], merged: [] },
  }));
  assert.deepEqual(kinds(res), ['CLOSED_WITH_OPEN_PR']);
  assert.equal(res.findings[0].detail, 'PR #12 还开着');
});
test('R6 prs 不可用 → 不命中', () => {
  const res = scanProject(input({
    board: { tasks: [card({ status: '暂缓' })], activity: [] },
    prs: { available: false, open: [], merged: [] },
  }));
  assert.deepEqual(kinds(res), []);
});

// ---- R7 PR 归属 ----
test('R7 标题 XFEAT-1 不得归给卡 FEAT-1', () => {
  const res = scanProject(input({
    board: { tasks: [card({ status: '暂缓' })], activity: [] },
    prs: { available: true, open: [{ number: 7, title: 'XFEAT-1: nope', headRefName: 'codex/q', updatedAt: ago(H) }], merged: [] },
  }));
  assert.deepEqual(kinds(res), []);
});
test('R7 括号写卡号与 prNumbers 都能归属', () => {
  const mk = (pr, c) => scanProject(input({
    board: { tasks: [card({ status: '已作废', ...c })], activity: [] },
    prs: { available: true, open: [pr], merged: [] },
  }));
  assert.deepEqual(kinds(mk({ number: 8, title: 'fix stuff (FEAT-1)', headRefName: 'b', updatedAt: ago(H) })), ['CLOSED_WITH_OPEN_PR']);
  assert.deepEqual(kinds(mk({ number: 8, title: 'plain', headRefName: 'b', updatedAt: ago(H) }, { prNumbers: [8] })), ['CLOSED_WITH_OPEN_PR']);
});

test('S1 等前置的两份契约不报多日无动静', () => {
  const res = scanProject(r5({ waitingPrereq: new Map([['FEAT-1', [
    { slug: 'slug-x', reasons: ['原因一', '其他'] }, { slug: 'slug-y', reasons: ['原因二'] },
  ]]]) }));
  assert.deepEqual(res.findings, []);
  assert.equal(res.waiting.length, 1);
  assert.match(res.waiting[0].detail, /slug-x\(原因一\).*slug-y\(原因二\)/);
});
test('S2 别的卡等前置不影响本卡', () => {
  const res = scanProject(r5({ waitingPrereq: new Map([['FEAT-2', [{ slug: 'slug-x', reasons: [] }]]]) }));
  assert.deepEqual(kinds(res), ['STALE_IN_PROGRESS']);
  assert.deepEqual(res.waiting, []);
});
test('S3 空契约数组仍报多日无动静', () => {
  const res = scanProject(r5({ waitingPrereq: new Map([['FEAT-1', []]]) }));
  assert.deepEqual(kinds(res), ['STALE_IN_PROGRESS']);
  assert.deepEqual(res.waiting, []);
});
test('S4 四份契约只显示前三份并写总数', () => {
  const entries = ['slug-a', 'slug-b', 'slug-c', 'slug-d'].map((slug) => ({ slug, reasons: [] }));
  const res = scanProject(r5({ waitingPrereq: new Map([['FEAT-1', entries]]) }));
  assert.match(res.waiting[0].detail, /^4 份契约在等前置:slug-a\(没写原因\);slug-b\(没写原因\);slug-c\(没写原因\);等 4 份$/);
});
test('S5 不传等待信息返回空数组', () => {
  const res = scanProject(r5());
  assert.deepEqual(kinds(res), ['STALE_IN_PROGRESS']);
  assert.deepEqual(res.waiting, []);
});
