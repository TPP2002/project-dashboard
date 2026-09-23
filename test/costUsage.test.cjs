'use strict';
// BOARD-COST-MONITOR(0901):cost 命令 + token 流水聚合的单测。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { getUsage, mapRepoToPrefix, selectProjectDirs, priceFor, usdActualOf } = require('../core/costUsage.cjs');
const { validate } = require('../core/boardSchema.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, P: { project: 't', registry: reg } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ---------- CLI cost 命令 ----------

test('cost 登记追加 entries 且各字段落地', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r1 = cmds.cost({ _: ['P01'], agents: 'sonnet:3,opus:1', tokens: '120000', note: '首轮', author: 'a1', ...P });
  const e1 = r1.task.cost.entries[0];
  assert.deepEqual(e1.agents, { sonnet: 3, opus: 1 });
  assert.equal(e1.tokens, 120000);
  assert.equal(e1.note, '首轮');
  assert.equal(e1.author, 'a1');
  assert.match(e1.date, /^\d{4}-\d{2}-\d{2}$/);
  const r2 = cmds.cost({ _: ['P01'], agents: 'fable:1', ...P });
  assert.equal(r2.task.cost.entries.length, 2, '第二次登记应追加不覆盖');
  clean(dir);
});

test('add --model 建议档位落卡,超长被拒', () => {
  const { dir, P } = setup();
  const r = cmds.add({ _: ['M1'], title: 'x', model: 'sonnet·低', ...P });
  assert.equal(r.task.modelHint, 'sonnet·低');
  assert.throws(() => cmds.add({ _: ['M2'], title: 'x', model: 'x'.repeat(41), ...P }), /太长/);
  clean(dir);
});

test('cost 同模型重复段累加、非法格式与负 tokens 被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r = cmds.cost({ _: ['P01'], agents: 'sonnet:2, sonnet:3', ...P });
  assert.deepEqual(r.task.cost.entries[0].agents, { sonnet: 5 });
  assert.throws(() => cmds.cost({ _: ['P01'], agents: 'fable=1', ...P }), /格式非法/);
  assert.throws(() => cmds.cost({ _: ['P01'], agents: 'fable:1', tokens: '-5', ...P }), /非负整数/);
  clean(dir);
});

test('schema:坏 cost(非法日期/agents 非对象)被校验拦下', () => {
  const board = {
    schemaVersion: '1.0',
    project: { id: 'x', name: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    tasks: [{ id: 'A1', title: 't', status: '未开工', wave: 0,
      cost: { entries: [{ date: '2026/09/01', agents: 'sonnet' }] } }],
  };
  const { ok, errors } = validate(board);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('cost.entries[0].date')), '应报日期格式');
  assert.ok(errors.some((e) => e.includes('cost.entries[0].agents')), '应报 agents 类型');
});

// ---------- costUsage 聚合 ----------

function jsonlLine({ ts, model, isSidechain, output, input, cacheRead, cacheWrite }) {
  return JSON.stringify({
    type: 'assistant', isSidechain: !!isSidechain, timestamp: ts, sessionId: 's',
    message: { model, usage: {
      input_tokens: input || 0, output_tokens: output || 0,
      cache_read_input_tokens: cacheRead || 0, cache_creation_input_tokens: cacheWrite || 0,
    } },
  });
}

test('getUsage:前缀匹配 worktree 目录、分桶聚合、坏行跳过、增量缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const root = path.join(dir, 'projects');
  for (const d of ['X--repo', 'X--repo--wt-1', 'Y--other']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const ts = new Date().toISOString(); // 今天,必落在 days 窗口内
  fs.writeFileSync(path.join(root, 'X--repo', 'a.jsonl'), [
    jsonlLine({ ts, model: 'claude-fable-5', output: 100, input: 10, cacheRead: 1000, cacheWrite: 50 }),
    jsonlLine({ ts, model: 'claude-sonnet-5', isSidechain: true, output: 30 }),
    '{"type":"user","text":"不含usage,应跳过"}',
    '这行不是JSON{{{',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'X--repo--wt-1', 'b.jsonl'),
    jsonlLine({ ts, model: 'claude-fable-5', output: 7 }));
  fs.writeFileSync(path.join(root, 'Y--other', 'c.jsonl'),
    jsonlLine({ ts, model: 'claude-opus-5', output: 99999 }));
  const cachePath = path.join(dir, 'cache.json');

  const r = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.deepEqual(r.dirs.sort(), ['X--repo', 'X--repo--wt-1'], 'Y--other 不得混入');
  assert.equal(r.totals.output, 137, '100+30+7,不含别的项目的 99999');
  assert.equal(r.totals.mainOutput, 107);
  assert.equal(r.totals.sideOutput, 30, 'isSidechain 应进子agent桶');
  assert.equal(r.models['claude-fable-5'].output, 107);
  assert.equal(r.models['claude-sonnet-5'].msgs, 1);
  assert.equal(r.scanned, 2);
  assert.equal(r.sessions, 2);

  const r2 = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.equal(r2.scanned, 0, '第二跑应全走缓存');
  assert.equal(r2.cachedFiles, 2);
  assert.equal(r2.totals.output, 137, '缓存结果与实扫一致');

  fs.appendFileSync(path.join(root, 'X--repo', 'a.jsonl'),
    '\n' + jsonlLine({ ts, model: 'claude-fable-5', output: 3 }));
  const r3 = await getUsage({ prefix: 'X--repo', days: 30, projectsRoot: root, cachePath });
  assert.equal(r3.scanned, 1, '只重扫变过的文件');
  assert.equal(r3.totals.output, 140, '追加后合计更新');

  clean(dir);
});

test('usdActualOf:没拿到专门缓存读价的档折算不变——opus 与 sonnet 与改动前完全一致', () => {
  const t = { input: 10, output: 100, cacheRead: 1000, cw5m: 0, cw1h: 50 };
  // opus in$5/out$25,无专门缓存读价 → 退回 0.1×in = 0.5:
  // (10×5 + 1000×0.5 + 50×2×5 + 100×25)/1e6 = 0.00355(改动前同式同值)
  assert.ok(Math.abs(usdActualOf(t, priceFor('claude-opus-5')) - 0.00355) < 1e-9);
  // sonnet in$2/out$10 → 退回 0.2:(10×2 + 1000×0.2 + 50×2×2 + 100×10)/1e6 = 0.00142
  assert.ok(Math.abs(usdActualOf(t, priceFor('claude-sonnet-5')) - 0.00142) < 1e-9);
});

test('Claude API 等价价目按准确版本，不把未知模型按相邻档计价', () => {
  assert.deepEqual(priceFor('claude-fable-5'), { in: 10, out: 50, cacheRead: 1 });
  assert.deepEqual(priceFor('claude-fable-5-1'), { in: 10, out: 50, cacheRead: 0.25 });
  assert.deepEqual(priceFor('claude-opus-5-5-20260901'), { in: 4, out: 20, cacheRead: 0.2 });
  assert.deepEqual(priceFor('claude-sonnet-4-5'), { in: 3, out: 15 });
  assert.equal(priceFor('claude-opus-6'), null);
  assert.equal(priceFor('glm-5.3'), null);
});

test('mapRepoToPrefix:非字母数字一律变 -(与 Claude Code 目录编码一致)', () => {
  assert.equal(mapRepoToPrefix('F:\\code-repo'), 'F--code-repo');
  assert.equal(mapRepoToPrefix('C:\\Users\\demo\\Documents\\job-repo'), 'C--Users-demo-Documents-job-repo');
});

test('getUsage:美元折算(缓存价生效,无TTL细分保守归1h桶)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usd-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'Z--p'), { recursive: true });
  const ts = new Date().toISOString();
  // fable 牌价 in$10/out$50:input10 + cacheRead1000 + cacheWrite50(无细分→1h桶×2) + output100
  fs.writeFileSync(path.join(root, 'Z--p', 'a.jsonl'),
    jsonlLine({ ts, model: 'claude-fable-5', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }));
  const r = await getUsage({ prefix: 'Z--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.totals.cw1h, 50, '无细分应全归 1h 桶');
  assert.equal(r.totals.cw5m, 0);
  // fable 5 的读价是 $1；$0.25 是 fable 5.1，不能混用版本价格。
  assert.ok(Math.abs(r.usd.actual - 0.0071) < 1e-9, `actual=${r.usd.actual}`);
  // noCache = ((10+1000+50)×10 + 100×50)/1e6 = 0.0156(全部输入按全价,与缓存读价无关,不跟着动)
  assert.ok(Math.abs(r.usd.noCache - 0.0156) < 1e-9, `noCache=${r.usd.noCache}`);
  assert.ok(Math.abs(r.usd.saved - 0.0085) < 1e-9, `saved=${r.usd.saved}`);
  assert.ok(r.byDay[0].usdActual > 0, '按天也应带折算');
  clean(dir);
});

test('同一 Claude Code 日志目录里的 GLM 不混入 Claude 成本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-usage-'));
  try {
    const root = path.join(dir, 'projects', 'Z--p'); fs.mkdirSync(root, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'a.jsonl'), [
      jsonlLine({ ts, model: 'claude-sonnet-5', input: 10, output: 5 }),
      jsonlLine({ ts, model: 'glm-5.3', input: 100, output: 50 }),
    ].join('\n'));
    const result = await getUsage({ prefix: 'Z--p', days: 1,
      projectsRoot: path.dirname(root), cachePath: path.join(dir, 'cache.json') });
    assert.equal(result.totals.output, 55);
    assert.equal(result.claudeTotals.output, 5);
    assert.equal(result.glmTotals.output, 50);
    assert.equal(result.usd.actual, (10 * 2 + 5 * 10) / 1e6);
  } finally { clean(dir); }
});

test('selectProjectDirs:独占多个前缀,保留目录原序并去重', () => {
  const dirNames = ['Z--desk-wt', 'F--x', 'Z--desk', 'Z--desk-wt', 'Y--other'];
  assert.deepEqual(selectProjectDirs(dirNames, {
    prefixes: ['F--x', 'Z--desk', 'Z--desk'], otherPrefixes: ['Y--other'],
  }), { dirs: ['Z--desk-wt', 'F--x', 'Z--desk'], shared: [] });
});

test('selectProjectDirs:归最长前缀,别人更长就让出,自己更长仍保留', () => {
  assert.deepEqual(selectProjectDirs([
    'F--x', 'F--x-team', 'F--x-team-wt', 'F--x-team-local', 'F--x-team-local-other',
  ], {
    prefixes: ['F--x', 'F--x-team-local'], otherPrefixes: ['F--x-team', 'F--x-team-local-other'],
  }), { dirs: ['F--x', 'F--x-team-local'], shared: [] });
});

test('selectProjectDirs:最长前缀完全并列时同时进 dirs 与 shared', () => {
  assert.deepEqual(selectProjectDirs([
    'F--x-team-wt', 'F--x', 'F--x-team', 'F--x-team-wt', 'F--x-team-deep',
  ], {
    prefixes: ['F--x', 'F--x-team'], otherPrefixes: ['F--x-team', 'F--x-team-deep'],
  }), {
    dirs: ['F--x-team-wt', 'F--x', 'F--x-team'], shared: ['F--x-team-wt', 'F--x-team'],
  });
});

test('selectProjectDirs:F--x 只含自己和 F--x-* ,不吞 F--x2', () => {
  assert.deepEqual(selectProjectDirs(['F--x2', 'F--x--wt', 'F--x', 'F--xy', 'F--x-branch'], {
    prefixes: ['F--x'], otherPrefixes: [],
  }), { dirs: ['F--x--wt', 'F--x', 'F--x-branch'], shared: [] });
});

test('getUsage:只给老参数 prefix 仍扫描自己与 worktree,排除相邻仓', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-legacy-'));
  t.after(() => clean(dir));
  const root = path.join(dir, 'projects');
  const ts = new Date().toISOString();
  for (const [name, output] of [['F--legacy', 11], ['F--legacy-wt', 7], ['F--legacy2', 900]]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'a.jsonl'), jsonlLine({ ts, model: 'claude-opus-5', output }));
  }
  const r = await getUsage({ prefix: 'F--legacy', projectsRoot: root, cachePath: path.join(dir, 'cache.json') });
  assert.deepEqual(r.dirs, ['F--legacy', 'F--legacy-wt']);
  assert.equal(r.totals.output, 18);
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.sharedDirs, []);
});

test('getUsage:prefixes 优先于 prefix,仲裁后扫描并暴露 sharedDirs,跨前缀复用缓存', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-roots-'));
  t.after(() => clean(dir));
  const root = path.join(dir, 'projects');
  const cachePath = path.join(dir, 'cache.json');
  const ts = new Date().toISOString();
  for (const [name, output] of [
    ['F--x', 11], ['F--x-team', 900], ['F--x2', 800], ['F--desk', 7], ['F--desk-wt', 3], ['Z--old', 700],
  ]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'a.jsonl'), jsonlLine({ ts, model: 'claude-opus-5', output }));
  }
  const r = await getUsage({
    prefix: 'Z--old', prefixes: ['F--x', 'F--desk', 'F--desk-wt', 'F--x'],
    otherPrefixes: ['F--x-team', 'F--desk'], projectsRoot: root, cachePath,
  });
  assert.deepEqual(r.dirs, ['F--desk', 'F--desk-wt', 'F--x']);
  assert.deepEqual(r.sharedDirs, ['F--desk'], 'worktree 的本项目前缀更长,不算并列');
  assert.equal(r.totals.output, 21);
  assert.equal(r.scanned, 3, '同一目录命中多个前缀也只能扫描一次');
  const cached = await getUsage({ prefixes: ['F--desk'], projectsRoot: root, cachePath });
  assert.deepEqual(cached.dirs, ['F--desk', 'F--desk-wt']);
  assert.equal(cached.totals.output, 10);
  assert.equal(cached.scanned, 0);
  assert.equal(cached.cachedFiles, 2, '缓存仍按文件绝对路径复用');
});

test('getUsage:没有有效本项目前缀时仍抛错,显式空 prefixes 不回落 prefix', async () => {
  for (const opts of [{}, { prefix: '' }, { prefixes: [] }, { prefix: 'F--old', prefixes: [] }, {
    prefixes: [], otherPrefixes: ['F--other'],
  }]) {
    await assert.rejects(getUsage(opts), /缺 prefix/);
  }
});

// ---------- COST-UI-SESSION-DETAIL:去重 / 压缩计数 / 缓存版本闸 ----------

/** 带 message.id / cwd 的流水行(去重与会话明细用)。 */
function sessionLine({ ts, id, sid, cwd, model = 'claude-sonnet-5', output = 0, input = 0, cacheRead = 0, cacheWrite = 0, type = 'assistant', extra = {} }) {
  return JSON.stringify({
    type, sessionId: sid, timestamp: ts, cwd, ...extra,
    message: type === 'assistant' ? { id, model, usage: {
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    } } : undefined,
  });
}

test('getUsage:message.id 去重——同 id 只记第一次;无 id/空 id/非字符串 id 各算各的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'D--p'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'D--p', 'a.jsonl'), [
    sessionLine({ ts, sid: 'sess-dedup-0001', id: 'msg_01', output: 10 }),
    sessionLine({ ts, sid: 'sess-dedup-0001', id: 'msg_01', output: 999 }), // 流式重发,忽略
    sessionLine({ ts, sid: 'sess-dedup-0001', id: '', output: 20 }), // 空 id:计入
    sessionLine({ ts, sid: 'sess-dedup-0001', id: undefined, output: 30 }), // 无 id:计入
    sessionLine({ ts, sid: 'sess-dedup-0001', id: 42, output: 40 }), // id 非字符串:计入
  ].join('\n'));
  const r = await getUsage({ prefix: 'D--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.totals.output, 100, '10+20+30+40;同 id 的 999 不得重复计入');
  assert.equal(r.sessionRows.length, 1);
  assert.equal(r.sessionRows[0].sessionId, 'sess-dedup-0001');
  assert.equal(r.sessionRows[0].turns, 4, '轮次 = 去重后的计入条数');
  clean(dir);
});

test('getUsage:压缩标记行不被预筛丢掉,type=summary 与 isCompactSummary 都计数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'C--p'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'C--p', 'a.jsonl'), [
    sessionLine({ ts, sid: 'sess-compact-0001', id: 'msg_c1', output: 5 }),
    '{"type":"summary","summary":"本轮压缩摘要","leafUuid":"u-1"}', // 不含 "assistant",旧预筛会扔
    JSON.stringify({ type: 'user', isCompactSummary: true, sessionId: 'sess-compact-0001', timestamp: ts }), // 同上
    '{"type":"user","text":"普通行,顺带提到 summary 这个词,不算压缩"}',
  ].join('\n'));
  const r = await getUsage({ prefix: 'C--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.sessionRows.length, 1, 'summary 行不带 sessionId 也归进文件里最近的会话,不另造幻影行');
  assert.equal(r.sessionRows[0].sessionId, 'sess-compact-0001');
  assert.equal(r.sessionRows[0].compactions, 2, '两种标记各计一次');
  assert.equal(r.totals.output, 5, '压缩标记行不产 token');
  assert.equal(r.totals.msgs, 1);
  clean(dir);
});

test('getUsage:缓存版本字段 schemaVersion 对不上,整份丢掉重扫', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cachev-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'V--p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'V--p', 'a.jsonl'),
    sessionLine({ ts: new Date().toISOString(), sid: 'sess-cache-0001', id: 'msg_v1', output: 7 }));
  const cachePath = path.join(dir, 'cache.json');
  const opts = { prefix: 'V--p', days: 30, projectsRoot: root, cachePath };
  assert.equal((await getUsage(opts)).scanned, 1, '首跑实扫');
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cached.schemaVersion, 3, '新缓存写 schemaVersion 字段');
  // 旧世界:字段还叫 version、号还是 2 —— 必须整份作废,而不是照单全收旧结构的桶
  fs.writeFileSync(cachePath, JSON.stringify({ version: 2, files: cached.files }));
  const r2 = await getUsage(opts);
  assert.equal(r2.scanned, 1, '版本对不上 → 重扫');
  assert.equal(r2.totals.output, 7, '重扫后数字正确');
  assert.equal((await getUsage(opts)).scanned, 0, '版本对得上 → 走缓存');
  clean(dir);
});
