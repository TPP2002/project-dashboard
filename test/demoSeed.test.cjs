'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validate } = require('../core/boardSchema.cjs');

test('演示 seed 在指定目录生成注册表与两块通过校验的示例板', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-seed-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve(__dirname, '../packaging/demo-seed.cjs'), dir], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  const registryPath = path.join(dir, 'registry.json');
  assert.ok(fs.existsSync(registryPath));
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.deepEqual(Object.keys(registry.projects).sort(), ['blog', 'shopfast']);
  for (const [id, project] of Object.entries(registry.projects)) {
    const expected = path.join(dir, 'boards', `${id}.json`);
    assert.equal(project.board, expected, '示例板必须留在本次临时目录');
    assert.ok(fs.existsSync(expected));
    const board = JSON.parse(fs.readFileSync(expected, 'utf8'));
    assert.equal(board.project.id, id);
    assert.ok(board.tasks.length > 0);
    const result = validate(board);
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
});

// ===== R3：演示数据日期按「运行当天 − 2026-07-02」整体平移的回归用例 =====
const SCRIPT = path.resolve(__dirname, '../packaging/demo-seed.cjs');
const BOARD_IDS = ['shopfast', 'blog'];

// YYYY-MM-DD → UTC 天序号，用来算两个日历日之间的整天差。
function dayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function makeHome(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-seed-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// today === undefined 表示不设置 DEMO_SEED_TODAY；否则按给定值设置。
function runSeed(home, today) {
  const env = { ...process.env };
  delete env.DEMO_SEED_TODAY;
  if (today !== undefined) env.DEMO_SEED_TODAY = today;
  return spawnSync(process.execPath, [SCRIPT, home], {
    windowsHide: true, encoding: 'utf8', timeout: 15000, env,
  });
}

function readBoard(home, id) {
  return JSON.parse(fs.readFileSync(path.join(home, 'boards', `${id}.json`), 'utf8'));
}

// 按固定遍历顺序收集板上全部日期字段，用于逐字段比较。
function collectDates(board) {
  const out = [];
  out.push(['project.createdAt', board.project.createdAt]);
  out.push(['project.updatedAt', board.project.updatedAt]);
  board.tasks.forEach((task, i) => {
    const d = task.dates || {};
    for (const k of ['design', 'start', 'done']) {
      if (d[k]) out.push([`tasks[${i}].dates.${k}`, d[k]]);
    }
    (task.decisions || []).forEach((dec, j) => {
      if (dec.decidedAt) out.push([`tasks[${i}].decisions[${j}].decidedAt`, dec.decidedAt]);
    });
  });
  (board.activity || []).forEach((a, i) => {
    if (a.ts) out.push([`activity[${i}].ts`, a.ts]);
  });
  return out;
}

// 抹掉全部日期字段，用于比较「除日期外一模一样」。
function stripDates(board) {
  const c = JSON.parse(JSON.stringify(board));
  delete c.project.createdAt;
  delete c.project.updatedAt;
  for (const task of c.tasks) {
    if (task.dates) {
      delete task.dates.design;
      delete task.dates.start;
      delete task.dates.done;
    }
    for (const dec of task.decisions || []) delete dec.decidedAt;
  }
  for (const a of c.activity || []) delete a.ts;
  return c;
}

test('(a) 平移量为 0：DEMO_SEED_TODAY=2026-07-02 时 shopfast 板保持原始日期', (t) => {
  const home = makeHome(t);
  const r = runSeed(home, '2026-07-02');
  assert.equal(r.status, 0, r.stderr);
  const shop = readBoard(home, 'shopfast');
  const feat2 = shop.tasks.find((task) => task.id === 'FEAT-2');
  assert.equal(feat2.dates.start, '2026-06-20');
  const latestTs = shop.activity.map((a) => a.ts).sort().at(-1);
  assert.equal(latestTs, '2026-07-01T15:00:00Z');
  assert.equal(shop.project.updatedAt, '2026-07-02T10:00:00Z');
});

test('(b) 两个「今天」相差 45 天：每个日期字段正好差 45 天，抹掉日期后两块板深度相等', (t) => {
  const home = makeHome(t);
  const r1 = runSeed(home, '2027-01-15');
  assert.equal(r1.status, 0, r1.stderr);
  const boardsA = { shopfast: readBoard(home, 'shopfast'), blog: readBoard(home, 'blog') };
  const r2 = runSeed(home, '2027-03-01');
  assert.equal(r2.status, 0, r2.stderr);
  const boardsB = { shopfast: readBoard(home, 'shopfast'), blog: readBoard(home, 'blog') };
  for (const id of BOARD_IDS) {
    const da = collectDates(boardsA[id]);
    const db = collectDates(boardsB[id]);
    assert.equal(da.length, db.length, `${id} 日期字段数量应一致`);
    for (let i = 0; i < da.length; i++) {
      assert.equal(da[i][0], db[i][0], '两次运行的日期字段路径应一致');
      assert.equal(
        dayNumber(db[i][1].slice(0, 10)) - dayNumber(da[i][1].slice(0, 10)),
        45,
        `${id} ${da[i][0]}: ${da[i][1]} → ${db[i][1]} 应正好相差 45 天`,
      );
      if (da[i][1].length > 10) {
        assert.equal(da[i][1].slice(10), db[i][1].slice(10), `${id} ${da[i][0]} 时刻后缀应不变`);
      }
    }
    assert.deepEqual(stripDates(boardsA[id]), stripDates(boardsB[id]), `${id} 抹掉日期后应深度相等`);
  }
});

test('(c) 2027-01-15：无未来日期、最新活动在一天内、施工中开工不超过 14 天、两块板通过校验', (t) => {
  const home = makeHome(t);
  const r = runSeed(home, '2027-01-15');
  assert.equal(r.status, 0, r.stderr);
  const today = '2027-01-15';
  for (const id of BOARD_IDS) {
    const board = readBoard(home, id);
    const v = validate(board);
    assert.equal(v.ok, true, v.errors.join('\n'));
    for (const [, value] of collectDates(board)) {
      assert.ok(dayNumber(value.slice(0, 10)) <= dayNumber(today),
        `${id} 出现晚于 ${today} 的日期：${value}`);
    }
    const latestActivityDate = board.activity.map((a) => a.ts.slice(0, 10)).sort().at(-1);
    assert.ok(dayNumber(latestActivityDate) >= dayNumber('2027-01-14'),
      `${id} 最新活动日期 ${latestActivityDate} 早于 2027-01-14`);
    for (const task of board.tasks) {
      if (task.status === '施工中' && task.dates && task.dates.start) {
        assert.ok(dayNumber(today) - dayNumber(task.dates.start) <= 14,
          `${id} ${task.id} 开工 ${task.dates.start} 距 ${today} 超过 14 天`);
      }
    }
  }
});

test('(d) 不设置 DEMO_SEED_TODAY：每块板最新活动时刻距测试运行时刻不超过 2 天', (t) => {
  const home = makeHome(t);
  const r = runSeed(home, undefined);
  assert.equal(r.status, 0, r.stderr);
  const nowMs = Date.now();
  for (const id of BOARD_IDS) {
    const board = readBoard(home, id);
    const latestTs = board.activity.map((a) => a.ts).sort().at(-1);
    const diffDays = Math.abs(nowMs - Date.parse(latestTs)) / 86400000;
    assert.ok(diffDays <= 2, `${id} 最新活动 ${latestTs} 距运行时刻 ${diffDays.toFixed(2)} 天，超过 2 天`);
  }
});

test('(e) DEMO_SEED_TODAY=not-a-date：子进程非零退出，目录里没有 registry.json', (t) => {
  const home = makeHome(t);
  const r = runSeed(home, 'not-a-date');
  assert.notEqual(r.status, 0, '非法日期应以非零退出码结束');
  assert.ok(!fs.existsSync(path.join(home, 'registry.json')), '非法日期不应生成 registry.json');
  const boardsDir = path.join(home, 'boards');
  if (fs.existsSync(boardsDir)) {
    assert.deepEqual(fs.readdirSync(boardsDir), [], '非法日期不应写任何板文件');
  }
});
