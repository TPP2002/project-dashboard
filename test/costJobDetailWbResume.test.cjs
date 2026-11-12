'use strict';
// WorkBuddy 工单明细:首轮加续聊各轮四桶;输入已含缓存,读时减掉缓存读写。
// 夹具一律 os.tmpdir() 临时目录 + 中性假名(公开仓红线),cost.json 只写需要的字段。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectJobRows, summarizeJobRows } = require('../core/costJobDetail.cjs');
const { createFileMemo } = require('../core/fileMemo.cjs');

const PEAK = '2026-09-14T10:00:00+08:00';
// exec.jsonl 最后一条 result 的顶层用量(snake_case),经 usageBuckets 得到四桶。
const EXEC_USAGE = {
  input_tokens: 1000, output_tokens: 50,
  cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
};
const assistant = (model = 'demo-a') => ({ type: 'assistant', message: { model } });
const result = (usage = EXEC_USAGE) => ({ type: 'result', subtype: 'success', is_error: false, usage });
const four = (row) => [row.input, row.output, row.cacheRead, row.cacheWrite];

function fixture(t) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'wb-resume-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempRoot, '只能清理本测试创建的临时目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { jobs: path.join(dir, 'jobs') };
}

function writeJob(jobsRoot, slug, { task = {}, events = [assistant()], meta = { dispatchedAt: PEAK }, state = {}, cost } = {}) {
  const dir = path.join(jobsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
  if (meta !== null) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (state !== null) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  if (events !== null) {
    fs.writeFileSync(path.join(dir, 'exec.jsonl'),
      events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n'));
  }
  if (cost !== undefined) fs.writeFileSync(path.join(dir, 'cost.json'), JSON.stringify(cost));
}

function writeCost(jobsRoot, slug, cost) {
  fs.writeFileSync(path.join(jobsRoot, slug, 'cost.json'), JSON.stringify(cost));
}

test('(a) WorkBuddy 首轮加续聊:两组各自 input 减缓存读写,逐桶相加,合计跟着变', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'workbuddy', model: 'demo-a' },
    events: [assistant()],
    cost: { engine: 'workbuddy',
      usage: { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 },
      resumeUsage: { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 } },
  });
  const [row] = await collectJobRows(f.jobs);
  assert.deepEqual(four(row), [300, 70, 900, 300]);
  assert.equal(row.input, (1000 - 600 - 200) + (500 - 300 - 100), '两组各自 input 减缓存读写之和');
  assert.equal(row.input + row.output + row.cacheRead + row.cacheWrite,
    (1000 + 50) + (500 + 20), '四列相加等于两组原始 input 加 output 之和');
  const sum = summarizeJobRows([row]);
  assert.deepEqual([sum.input, sum.output, sum.cacheRead, sum.cacheWrite], [300, 70, 900, 300]);
});

test('(a) 口径事实那组数:input 为 0、四列相加为真实总量 1020000', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy',
      usage: { input: 1000000, output: 20000, cacheRead: 950000, cacheWrite: 50000 } },
  });
  const [row] = await collectJobRows(f.jobs);
  assert.equal(row.input, 0, 'input 减去缓存读写后为 0');
  assert.deepEqual(four(row), [0, 20000, 950000, 50000]);
  assert.equal(row.input + row.output + row.cacheRead + row.cacheWrite, 1020000, '四列相加等于真实总 token');
});

test('(b) resumeUsage 为 null 或缺失时四列只有首轮(首轮照样换算)', async (t) => {
  const f = fixture(t);
  const usage = { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 };
  writeJob(f.jobs, 'resume-null', {
    task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage, resumeUsage: null },
  });
  writeJob(f.jobs, 'resume-missing', {
    task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage },
  });
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((r) => [r.slug, r]));
  assert.deepEqual(four(by.get('resume-null')), [200, 50, 600, 200]);
  assert.deepEqual(four(by.get('resume-missing')), [200, 50, 600, 200]);
});

test('(c) cost.usage 为 null 时首轮整组取 exec 并换算,续聊照加', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'workbuddy' }, events: [result()],
    cost: { engine: 'workbuddy', usage: null,
      resumeUsage: { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 } },
  });
  const [row] = await collectJobRows(f.jobs);
  // exec 四桶 {1000,50,600,200} → 换算 input 200;续聊换算 input 100
  assert.deepEqual(four(row), [300, 70, 900, 300]);
});

test('(d) resumeUsage 坏桶逐桶当 0,其余照取,换算按归零后的值', async (t) => {
  const f = fixture(t);
  const usage = { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 };
  const cases = {
    'neg': { input: -5, output: 20, cacheRead: 300, cacheWrite: 100 },
    'frac': { input: 1.5, output: 20, cacheRead: 300, cacheWrite: 100 },
    'str': { input: '300', output: 20, cacheRead: 300, cacheWrite: 100 },
    'missing': { output: 20, cacheRead: 300, cacheWrite: 100 },
    'badread': { input: 500, output: 20, cacheRead: 'x', cacheWrite: 100 },
    'badout': { input: 500, output: 'x', cacheRead: 300, cacheWrite: 100 },
  };
  for (const [slug, resumeUsage] of Object.entries(cases)) {
    writeJob(f.jobs, slug, { task: { engine: 'workbuddy' }, events: [assistant()],
      cost: { engine: 'workbuddy', usage, resumeUsage } });
  }
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((r) => [r.slug, r]));
  for (const slug of ['neg', 'frac', 'str', 'missing']) {
    assert.deepEqual(four(by.get(slug)), [200, 70, 900, 300], slug + ': input 坏桶归零,其余照取');
  }
  assert.deepEqual(four(by.get('badread')), [600, 70, 600, 300], 'cacheRead 归零后换算 input 为 400');
  assert.deepEqual(four(by.get('badout')), [300, 50, 900, 300], 'output 坏桶归零,其余照取');
});

test('(e) cost.usage 某桶不合法时首轮四桶整组取 exec,不混取,续聊照加', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'workbuddy' },
    events: [result({ input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 })],
    cost: { engine: 'workbuddy',
      usage: { input: 1000, output: 'bad', cacheRead: 600, cacheWrite: 200 },
      resumeUsage: { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 } },
  });
  const [row] = await collectJobRows(f.jobs);
  // 首轮整组取 exec {7,8,3,2} → 换算 7-(3+2)=2;续聊换算 500-(300+100)=100
  assert.deepEqual(four(row), [102, 28, 303, 102], 'input/输出都不取 cost.usage 的合法桶,整组来自 exec');
});

test('(f) 某组 input 小于缓存读写之和时该组 input 原样不动', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'first-small', {
    task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy',
      usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 100 } },
  });
  writeJob(f.jobs, 'resume-small', {
    task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy',
      usage: { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 },
      resumeUsage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 100 } },
  });
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((r) => [r.slug, r]));
  assert.deepEqual(four(by.get('first-small')), [100, 20, 300, 100], '首轮 100 小于 400 → input 原样 100');
  assert.deepEqual(four(by.get('resume-small')), [300, 70, 900, 300], '续聊 100 小于 400 → 续聊 input 原样 100');
});

test('(g) inputExcludesCache: true 只让本组不换算,两处各自判断,严格等于 true', async (t) => {
  const f = fixture(t);
  const usage = { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 };
  const resume = { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 };
  writeJob(f.jobs, 'g-first', { task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage: { ...usage, inputExcludesCache: true }, resumeUsage: resume } });
  writeJob(f.jobs, 'g-resume', { task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage, resumeUsage: { ...resume, inputExcludesCache: true } } });
  writeJob(f.jobs, 'g-both', { task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage: { ...usage, inputExcludesCache: true },
      resumeUsage: { ...resume, inputExcludesCache: true } } });
  writeJob(f.jobs, 'g-not-strict', { task: { engine: 'workbuddy' }, events: [assistant()],
    cost: { engine: 'workbuddy', usage: { ...usage, inputExcludesCache: 'true' }, resumeUsage: resume } });
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((r) => [r.slug, r]));
  assert.equal(by.get('g-first').input, 1100, '首轮不换算 1000 + 续聊换算 100');
  assert.equal(by.get('g-resume').input, 700, '首轮换算 200 + 续聊不换算 500');
  assert.equal(by.get('g-both').input, 1500, '两组都不换算');
  assert.equal(by.get('g-not-strict').input, 300, '字符串 true 不算,照常换算');
});

test('(h) codex/deepseek 带 resumeUsage 不加不换算,glm 与改前逐项相同', async (t) => {
  const f = fixture(t);
  const camel = { input: 999, output: 888, cacheRead: 777, cacheWrite: 666 };
  const camelResume = { input: 555, output: 444, cacheRead: 333, cacheWrite: 222 };
  for (const engine of ['codex', 'deepseek']) {
    writeJob(f.jobs, engine, { task: { engine }, events: [result()],
      cost: { engine, usage: camel, resumeUsage: camelResume } });
  }
  writeJob(f.jobs, 'glm-job', { task: { engine: 'glm', model: 'demo-a' }, events: [assistant()],
    cost: { engine: 'glm', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 },
      resumeUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      glmQuota: { weeklyDelta: 15 }, attribution: { attributable: false } } });
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((r) => [r.slug, r]));
  for (const engine of ['codex', 'deepseek']) {
    assert.deepEqual(four(by.get(engine)), [1000, 50, 600, 200], engine + ': 只取 exec 顶层用量,不加不加换算');
  }
  assert.deepEqual(four(by.get('glm-job')), [11, 22, 33, 4], 'GLM 仍逐桶首轮加续聊,逐项与改前相同');
});

test('(i) turns 仍等于 exec.jsonl 的 assistant 条数,不含续聊;workbuddyCredits 不变', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'workbuddy' },
    events: [assistant(), assistant(), result()],
    cost: { engine: 'workbuddy',
      usage: { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 },
      resumeUsage: { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 },
      resumeRounds: 3, coversResumeRounds: true,
      workbuddyCredits: { credits: 1.49 } },
  });
  const [row] = await collectJobRows(f.jobs);
  assert.equal(row.turns, 2, '轮次只数 assistant 事件,不含 resumeRounds');
  assert.equal(row.workbuddyCredits, 1.49, '积分列不动');
  assert.deepEqual(four(row), [300, 70, 900, 300], '四列照常首轮加续聊');
});

test('(j) 传 memo 与不传深度相等;改写 cost.json 追加续聊后同 memo 再读四列变新值', async (t) => {
  const f = fixture(t);
  const usage = { input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 };
  const v1 = { engine: 'workbuddy', usage,
    resumeUsage: { input: 500, output: 20, cacheRead: 300, cacheWrite: 100 } };
  const v2 = { engine: 'workbuddy', usage,
    resumeUsage: { input: 850, output: 90, cacheRead: 500, cacheWrite: 150 },
    resumeRounds: 2, coversResumeRounds: true };
  writeJob(f.jobs, 'job-a', { task: { engine: 'workbuddy' }, events: [assistant()], cost: v1 });
  const memo = createFileMemo();
  const withMemo = await collectJobRows(f.jobs, { memo });
  assert.deepEqual(withMemo, await collectJobRows(f.jobs), '带缓存与不带缓存逐项相等');
  assert.deepEqual(four(withMemo[0]), [300, 70, 900, 300]);
  writeCost(f.jobs, 'job-a', v2);
  const reread = await collectJobRows(f.jobs, { memo });
  assert.deepEqual(reread, await collectJobRows(f.jobs), '改写后带缓存与不带缓存仍逐项相等');
  assert.deepEqual(four(reread[0]), [400, 140, 1100, 350], '追加一轮续聊后四列变成新值');
});
