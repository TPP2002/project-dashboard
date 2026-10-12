'use strict';
// COST-SUBAGENT-TRANSCRIPTS-MISSED(0924 拍板):成本统计要把 <项目>/<父会话>/subagents/ 下
// 全部子代理流水(含 workflows 深一层)并进总量、主/子桶与父会话明细——同组去重、按父会话归账、
// 组级增量缓存。夹具一律 os.tmpdir() 临时目录 + 合成假值,照真实目录结构摆,不碰真实流水目录。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getUsage } = require('../core/costUsage.cjs');

const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** 真实结构的 assistant 行:id 缺省 = 不带 message.id;isSidechain = 子代理行。 */
function line({ ts, sid, id, cwd, gitBranch, model = 'claude-sonnet-5', input = 0, output = 0,
  cacheRead = 0, cacheWrite = 0, isSidechain = false }) {
  return JSON.stringify({
    type: 'assistant', isSidechain, timestamp: ts, sessionId: sid, cwd, gitBranch,
    message: { ...(id === undefined ? {} : { id }), model, usage: {
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    } },
  });
}

const now = () => new Date().toISOString(); // 今天,必落在 days 窗口内

/** 在 projectsRoot 下摆一个真实结构的项目目录:父流水 <name>/<sid>.jsonl + <name>/<sid>/subagents/ 递归子文件。 */
function makeProject(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    parent: (sid, lines) => fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n')),
    sub: (sid, rel, lines) => {
      const abs = path.join(dir, sid, 'subagents', ...rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, lines.join('\n'));
      return abs;
    },
  };
}

/** 这一条是本单最要紧的对账断言:明细行四类 token 相加必须等于顶层合计(子代理的账也在内)。 */
function reconcile(r) {
  const sum = (pick) => r.sessionRows.reduce((acc, row) => acc + pick(row), 0);
  assert.equal(sum((x) => x.input), r.totals.input, 'input:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.output), r.totals.output, 'output:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.cacheRead), r.totals.cacheRead, 'cacheRead:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.cacheWrite), r.totals.cacheWrite, 'cacheWrite:明细行相加 === 顶层合计');
}

test('getUsage:subagents 直挂与 workflows 深层都进总量与父会话明细,会话数不因代理文件膨胀', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-aggr-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'P--main');
  const sid = 'sess-aggr-0001';
  p.parent(sid, [line({ ts: now(), sid, id: 'msg_p1', input: 3, output: 10, cacheRead: 100, cacheWrite: 7 })]);
  p.sub(sid, ['agent-alpha.jsonl'],
    [line({ ts: now(), sid, id: 'msg_a1', output: 20, isSidechain: true })]);
  p.sub(sid, ['agent-beta.jsonl'],
    [line({ ts: now(), sid, id: 'msg_b1', output: 30, isSidechain: true })]);
  p.sub(sid, ['workflows', 'wf-main', 'agent-gamma.jsonl'],
    [line({ ts: now(), sid, id: 'msg_g1', output: 40, isSidechain: true })]);
  const r = await getUsage({ prefix: 'P--main', days: 30, projectsRoot: root, cachePath: path.join(dir, 'cache.json') });
  assert.equal(r.totals.output, 100, '10+20+30+40,workflows 深层的也算');
  assert.equal(r.totals.input, 3);
  assert.equal(r.totals.mainOutput, 10);
  assert.equal(r.totals.sideOutput, 90, '子代理行按行上 isSidechain 进子桶');
  assert.equal(r.sessions, 1, '三个子文件不许把会话数撑成 4');
  assert.equal(r.scanned, 4, 'scanned 反映物理文件数');
  assert.equal(r.sessionRows.length, 1);
  assert.equal(r.sessionRows[0].sessionId, sid);
  assert.equal(r.sessionRows[0].turns, 4, '子代理轮次并入父会话明细');
  assert.equal(r.sessionRows[0].output, 100);
  reconcile(r);
  clean(dir);
});

test('getUsage:同组父/子文件共享 message.id 去重;无/空/非字符串 id 沿现有规则逐条计', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-dedup-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'D--dup');
  const sid = 'sess-dedup-0002';
  p.parent(sid, [
    line({ ts: now(), sid, id: 'msg_dup', output: 10 }),
    line({ ts: now(), sid, id: 'msg_dup', output: 900 }), // 父内流式重发
    line({ ts: now(), sid, id: '', output: 1 }), // 空 id:计入
    line({ ts: now(), sid, id: 42, output: 2 }), // 非字符串:计入
    line({ ts: now(), sid, output: 3 }), // 无 id:计入
  ]);
  p.sub(sid, ['agent-alpha.jsonl'], [
    line({ ts: now(), sid, id: 'msg_dup', output: 800 }), // 与父同 id:组内只记第一次
    line({ ts: now(), sid, id: 'msg_sub', output: 5 }),
  ]);
  p.sub(sid, ['agent-beta.jsonl'], [
    line({ ts: now(), sid, id: 'msg_sub', output: 700 }), // 与另一子文件同 id
    line({ ts: now(), sid, output: 4 }), // 无 id:逐条计
  ]);
  const r = await getUsage({ prefix: 'D--dup', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.totals.output, 25, '10+1+2+3+5+4;900/800/700 三笔重发不得计入');
  assert.equal(r.totals.msgs, 6);
  assert.equal(r.sessionRows[0].turns, 6, '轮次 = 组内去重后的计入条数');
  reconcile(r);
  clean(dir);
});

test('getUsage:不同父会话组之间不误去重——同 id 在两组各记各的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-cross-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'X--cross');
  p.parent('sess-cross-0001', [line({ ts: now(), sid: 'sess-cross-0001', id: 'msg_same', output: 10 })]);
  p.sub('sess-cross-0001', ['agent-1.jsonl'],
    [line({ ts: now(), sid: 'sess-cross-0001', id: 'msg_same', output: 900 })]);
  p.parent('sess-cross-0002', [line({ ts: now(), sid: 'sess-cross-0002', id: 'msg_same', output: 20 })]);
  p.sub('sess-cross-0002', ['agent-2.jsonl'],
    [line({ ts: now(), sid: 'sess-cross-0002', id: 'msg_same', output: 800 })]);
  const r = await getUsage({ prefix: 'X--cross', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.totals.output, 30, '组内去重、跨组不去重:10+20');
  assert.equal(r.sessions, 2);
  assert.equal(r.sessionRows.length, 2);
  reconcile(r);
  clean(dir);
});

test('getUsage:父会话判卡证据只认父流水——子代理的 claim/--branch/分支/cwd 不得混入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-sig-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'S--sig');
  const ts0 = now();
  const parentCwd = path.join(dir, 'parent-repo');
  const subCwd = path.join(dir, 'sub-repo');
  // 有自己信号的父会话:分支命中 PARENT-CARD;子代理带着 SUB-CARD 的分支与 claim 混不进来
  p.parent('sess-sig-0001', [
    line({ ts: ts0, sid: 'sess-sig-0001', cwd: parentCwd, gitBranch: 'feat/parent', id: 'msg_s1', output: 5 }),
    JSON.stringify({ type: 'user', sessionId: 'sess-sig-0001', timestamp: ts0,
      message: { content: 'claim PARENT-CARD --branch feat/parent' } }),
  ]);
  p.sub('sess-sig-0001', ['agent-1.jsonl'], [
    line({ ts: ts0, sid: 'sess-sig-0001', cwd: subCwd, gitBranch: 'feat/sub',
      id: 'msg_sub1', output: 6, isSidechain: true }),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: 'sess-sig-0001', timestamp: ts0,
      message: { content: 'claim SUB-CARD --branch feat/sub' } }),
  ]);
  // 完全没有信号的父会话:子代理的信号同样不许替它判卡或补 cwd
  p.parent('sess-clean-0002', [line({ ts: ts0, sid: 'sess-clean-0002', id: 'msg_c1', output: 7 })]);
  p.sub('sess-clean-0002', ['agent-2.jsonl'], [
    line({ ts: ts0, sid: 'sess-clean-0002', cwd: subCwd, gitBranch: 'feat/sub',
      id: 'msg_sub2', output: 8, isSidechain: true }),
  ]);
  const cards = [
    { id: 'PARENT-CARD', gitBranch: ['feat/parent'] },
    { id: 'SUB-CARD', gitBranch: ['feat/sub'] },
  ];
  const r = await getUsage({ prefix: 'S--sig', days: 7, projectsRoot: root,
    cachePath: path.join(dir, 'cache.json'), cards });
  const bySid = new Map(r.sessionRows.map((row) => [row.sessionId, row]));
  assert.equal(bySid.get('sess-sig-0001').attribution.level, 'branch');
  assert.deepEqual(bySid.get('sess-sig-0001').attribution.cardIds, ['PARENT-CARD'],
    '只认父流水的分支证据,子代理的 SUB-CARD 混不进来');
  assert.equal(bySid.get('sess-sig-0001').card, 'PARENT-CARD');
  assert.equal(bySid.get('sess-sig-0001').cwd, parentCwd, 'cwd 以父流水为准');
  assert.equal(bySid.get('sess-clean-0002').attribution.status, 'unattributed',
    '父会话自己没有信号,子代理的分支/claim 不能替它判卡');
  assert.equal(bySid.get('sess-clean-0002').cwd, null, '子代理的 cwd 不能补进父会话');
  reconcile(r);
  clean(dir);
});

test('getUsage:热缓存整组命中——第二跑零实扫,结果与实扫一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-hot-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'H--hot');
  const sid = 'sess-hot-0001';
  p.parent(sid, [line({ ts: now(), sid, id: 'msg_h1', output: 10 })]);
  p.sub(sid, ['agent-alpha.jsonl'], [line({ ts: now(), sid, id: 'msg_h2', output: 20, isSidechain: true })]);
  p.sub(sid, ['workflows', 'wf', 'agent-beta.jsonl'], [line({ ts: now(), sid, id: 'msg_h3', output: 30, isSidechain: true })]);
  const opts = { prefix: 'H--hot', days: 30, projectsRoot: root, cachePath: path.join(dir, 'cache.json') };
  const fresh = await getUsage(opts);
  assert.equal(fresh.scanned, 3);
  const cached = await getUsage(opts);
  assert.equal(cached.scanned, 0, '第二跑整组走缓存');
  assert.equal(cached.cachedFiles, 3, 'cachedFiles 反映物理文件数(含子文件)');
  assert.equal(cached.totals.output, fresh.totals.output);
  assert.equal(cached.sessions, 1);
  assert.deepEqual(cached.sessionRows, fresh.sessionRows);
  assert.deepEqual(cached.byDay, fresh.byDay);
  reconcile(cached);
  clean(dir);
});

test('getUsage:子文件追加/新增/删除都使所在组重建,没变的组照旧命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-incr-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'I--incr');
  const sid = 'sess-incr-0001';
  p.parent(sid, [line({ ts: now(), sid, id: 'msg_i1', output: 10 })]);
  const alpha = p.sub(sid, ['agent-alpha.jsonl'],
    [line({ ts: now(), sid, id: 'msg_i2', output: 20, isSidechain: true })]);
  const q = makeProject(root, 'I--incr-more'); // 旁边一个不受影响的组
  q.parent('sess-incr-0002', [line({ ts: now(), sid: 'sess-incr-0002', id: 'msg_i3', output: 7 })]);
  const opts = { prefix: 'I--incr', days: 30, projectsRoot: root, cachePath: path.join(dir, 'cache.json') };
  assert.equal((await getUsage(opts)).scanned, 3, '首扫:两个父组共 3 个物理文件');

  fs.appendFileSync(alpha, '\n' + line({ ts: now(), sid, id: 'msg_i4', output: 5, isSidechain: true }));
  let r = await getUsage(opts);
  assert.equal(r.scanned, 2, '子文件追加了:整组(父+子)重建,父文件没变也得重扫');
  assert.equal(r.cachedFiles, 1, '没变的组照旧命中');
  assert.equal(r.totals.output, 42, '10+20+5,旁边没变的组仍贡献 7');

  const beta = p.sub(sid, ['workflows', 'wf', 'agent-beta.jsonl'],
    [line({ ts: now(), sid, id: 'msg_i5', output: 40, isSidechain: true })]);
  r = await getUsage(opts);
  assert.equal(r.scanned, 3, '新增子文件(workflows 深层)也使整组重建');
  assert.equal(r.cachedFiles, 1);
  assert.equal(r.totals.output, 82);

  fs.rmSync(beta);
  r = await getUsage(opts);
  assert.equal(r.scanned, 2, '删除子文件同样使整组重建');
  assert.equal(r.cachedFiles, 1);
  assert.equal(r.totals.output, 42, '删掉的子文件不再计入');
  reconcile(r);
  clean(dir);
});

test('getUsage:v4 旧缓存整份作废重扫,重扫后写 v5 并恢复组命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-v4-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'V--ver');
  const sid = 'sess-ver-0001';
  p.parent(sid, [line({ ts: now(), sid, id: 'msg_v1', output: 10 })]);
  p.sub(sid, ['agent-a.jsonl'], [line({ ts: now(), sid, id: 'msg_v2', output: 20, isSidechain: true })]);
  const cachePath = path.join(dir, 'cache.json');
  const opts = { prefix: 'V--ver', days: 30, projectsRoot: root, cachePath };
  assert.equal((await getUsage(opts)).scanned, 2, '首扫实扫');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.schemaVersion, 5, '新缓存写 v5');
  // 伪造成 v4 旧世界(按单文件存、无整组指纹)——必须整份作废,而不是照单全收旧结构的桶
  fs.writeFileSync(cachePath, JSON.stringify({ schemaVersion: 4, files: cache.files }));
  const r2 = await getUsage(opts);
  assert.equal(r2.scanned, 2, '版本对不上 → 整组重扫');
  assert.equal(r2.totals.output, 30, '重扫后数字正确');
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).schemaVersion, 5, '重扫后写回 v5');
  assert.equal((await getUsage(opts)).scanned, 0, '版本对得上 → 恢复组命中');
  clean(dir);
});

test('getUsage:多个项目前缀各算各的——subagents 不串项目,同 id 跨项目也不误去重', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-prefix-'));
  const root = path.join(dir, 'projects');
  const a = makeProject(root, 'M--one');
  a.parent('sess-one-0001', [line({ ts: now(), sid: 'sess-one-0001', id: 'msg_m1', output: 10 })]);
  a.sub('sess-one-0001', ['agent-a.jsonl'],
    [line({ ts: now(), sid: 'sess-one-0001', id: 'msg_same', output: 20, isSidechain: true })]);
  const b = makeProject(root, 'M--two');
  b.parent('sess-two-0002', [line({ ts: now(), sid: 'sess-two-0002', id: 'msg_same', output: 40 })]);
  b.sub('sess-two-0002', ['agent-b.jsonl'],
    [line({ ts: now(), sid: 'sess-two-0002', id: 'msg_b2', output: 80, isSidechain: true })]);
  const one = await getUsage({ prefix: 'M--one', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c1.json') });
  assert.equal(one.totals.output, 30, '另一个项目的 40+80 不许串进来');
  assert.equal(one.sessionRows.length, 1);
  reconcile(one);
  const both = await getUsage({ prefixes: ['M--one', 'M--two'], days: 30, projectsRoot: root, cachePath: path.join(dir, 'c2.json') });
  assert.equal(both.totals.output, 150, '30+120;msg_same 在两组的账里各出现一次(20+40),不跨组误去重');
  assert.equal(both.sessions, 2);
  assert.equal(both.scanned, 4);
  reconcile(both);
  clean(dir);
});

test('getUsage:父流水没有 assistant 记录时,子代理的账仍归到父会话名下', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-bare-'));
  const root = path.join(dir, 'projects');
  const p = makeProject(root, 'B--bare');
  const sid = 'sess-bare-0001';
  p.parent(sid, [JSON.stringify({ type: 'user', sessionId: sid, timestamp: now(),
    message: { content: '开场白,还没轮到 assistant' } })]);
  p.sub(sid, ['agent-a.jsonl'], [line({ ts: now(), sid, id: 'msg_b1', output: 33, isSidechain: true })]);
  const r = await getUsage({ prefix: 'B--bare', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.sessions, 1, '子文件有账,会话仍只算一个');
  assert.equal(r.totals.output, 33);
  assert.equal(r.sessionRows.length, 1, '明细行必须出现,否则明细相加对不上顶层');
  assert.equal(r.sessionRows[0].sessionId, sid);
  assert.equal(r.sessionRows[0].output, 33);
  reconcile(r);
  clean(dir);
});
