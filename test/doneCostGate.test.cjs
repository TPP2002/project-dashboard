'use strict';
// COST-LEDGER-CLOSEOUT-DISCIPLINE(0914 负责人当面下达并当场加码):每张卡收官前必须登记这一单
// 消耗了多少,不登记不得收官。闸位 = done 命令,硬度 = 硬闸 + 留痕逃生门(逃生门在 cost --unknown
// 那一侧,done 本身不给绕过开关)。三类计价各有结构化字段:--rmb(按量付费的真实人民币)、
// --credits + --credit-unit(订阅制消耗的额度)、--tokens(兜底)。
//
// 本文件覆盖三件事:①什么算一笔真账、什么不算(agents 刻意不算);②done 拦得住 / 放得过 /
// 两处刻意不拦(--collect 与已完工卡);③cost 的参数校验不许把假数字记进账(裸 flag、负数、
// credits 与单位落单)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const INDEX = path.join(__dirname, '..', 'cli', 'index.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dcg-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, reg, board: path.join(root, '.dashboard', 'board.json') };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发句柄滞留 */ } };

/** 跑真 CLI 入口,返回 {code, out}。 */
function cli(reg, ...args) {
  try {
    const out = execFileSync('node', [INDEX, ...args, '--registry', reg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
/** 建一张已 claim 的卡,省掉每个用例重复五行。 */
function seedCard(reg, id) {
  const r = cli(reg, 'add', id, '--project', 't', '--model', 'sonnet·中',
    '--title', '一张用来验收官闸的卡', '--plain-title', '这张卡只是用来测收官那道闸拦不拦得住');
  assert.equal(r.code, 0, '建卡应成功,实际:' + r.out);
}
const readTask = (board, id) => (JSON.parse(fs.readFileSync(board, 'utf8')).tasks || []).find((t) => t.id === id);

// ── ① done 拦得住:一条账都没有 ──────────────────────────────────────────────
test('done:卡上零账目 → 拒收,报错给出可粘贴的补账命令与逃生门', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const r = cli(reg, 'done', 'T1', '--project', 't');
  assert.notEqual(r.code, 0, 'done 应被拦下,实际 code=' + r.code + ' 输出:' + r.out);
  assert.match(r.out, /不登记不得收官/, '报错要点明这条纪律');
  assert.match(r.out, /--rmb/, '报错要给按量付费那一路的命令');
  assert.match(r.out, /--credits/, '报错要给订阅制那一路的命令');
  assert.match(r.out, /--unknown/, '报错要给留痕逃生门');
  assert.equal(readTask(board, 'T1').status, '未开工', '被拦下时状态一个字都不许动');
  clean(dir);
});

// ── ② 只有 agents 不算账(否则这道闸等于只查「有没有人点过 cost」) ──────────
test('done:账目只有 agents、没有任何消耗量 → 照样拒收', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', '--note', '干了点活');
  assert.equal(c.code, 0, 'cost 本身照记(账目是流水,不该丢),实际:' + c.out);
  assert.match(c.out, /不够 done 那道闸放行/, 'cost 应当场提醒这一笔不顶账');
  assert.ok(readTask(board, 'T1').cost.entries.length === 1, '这一笔应当真的记进去了');
  const r = cli(reg, 'done', 'T1', '--project', 't');
  assert.notEqual(r.code, 0, '只有 agents 不算量,done 应被拦下。实际输出:' + r.out);
  clean(dir);
});

// ── ③ 三类量各自都能放行 ────────────────────────────────────────────────────
for (const [label, extra, expect] of [
  ['人民币(按量付费)', ['--tokens', '15437329', '--rmb', '0.9632'], { rmb: 0.9632, tokens: 15437329 }],
  ['额度(订阅制)', ['--credits', '6209', '--credit-unit', '积分'], { credits: 6209, creditUnit: '积分' }],
  ['token 兜底', ['--tokens', '120000'], { tokens: 120000 }],
]) {
  test(`done:账目带${label} → 放行,字段结构化落盘`, () => {
    const { dir, reg, board } = setup();
    seedCard(reg, 'T1');
    const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', ...extra);
    assert.equal(c.code, 0, 'cost 应成功,实际:' + c.out);
    const entry = readTask(board, 'T1').cost.entries[0];
    for (const [k, v] of Object.entries(expect)) assert.equal(entry[k], v, `账目字段 ${k} 应为 ${v},实际 ${entry[k]}`);
    const r = cli(reg, 'done', 'T1', '--project', 't');
    assert.equal(r.code, 0, 'done 应放行,实际输出:' + r.out);
    assert.equal(readTask(board, 'T1').status, '已完工');
    clean(dir);
  });
}

// ── ④ 留痕逃生门:算不出也能收官,但账上留下「量不出 + 理由」 ────────────────
test('cost --unknown:算不出也算登记,条目标着量不出并带理由,done 放行', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', '--unknown', '平台没给用量,只知道跑了一轮');
  assert.equal(c.code, 0, 'cost --unknown 应成功,实际:' + c.out);
  const entry = readTask(board, 'T1').cost.entries[0];
  assert.equal(entry.unknown, true, '条目要明确标着量不出');
  assert.match(entry.unknownReason, /只知道跑了一轮/, '理由要原样留在账上,评估时才挑得出来');
  assert.equal(cli(reg, 'done', 'T1', '--project', 't').code, 0, '留痕逃生门应放行');
  clean(dir);
});

test('cost --unknown 裸给(不写理由)→ 拒收,不许拿空逃生门顶账', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', '--unknown');
  assert.notEqual(c.code, 0, '裸 --unknown 应拒收,实际 code=' + c.code);
  assert.match(c.out, /为什么/, '报错要要求写清为什么算不出');
  assert.equal(readTask(board, 'T1').cost, undefined, '拒收时不许留下半条账');
  clean(dir);
});

// ── ⑤ 两处刻意不拦 ──────────────────────────────────────────────────────────
test('done --collect:零账目也放行(还没到收官那一步)', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const r = cli(reg, 'done', 'T1', '--project', 't', '--collect');
  assert.equal(r.code, 0, '--collect 不受本闸约束,实际输出:' + r.out);
  assert.equal(readTask(board, 'T1').status, '收官');
  clean(dir);
});

test('已完工的卡回头补 PR 号:零账目也放行(它当初过闸才进得了这个状态)', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', '--tokens', '1000');
  assert.equal(cli(reg, 'done', 'T1', '--project', 't').code, 0);
  // 把账整份抹掉,模拟「老卡本来就没账」:已完工状态下补 PR 号不该被拦。
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  delete b.tasks.find((t) => t.id === 'T1').cost;
  fs.writeFileSync(board, JSON.stringify(b, null, 2));
  const r = cli(reg, 'done', 'T1', '--project', 't', '--pr', '42');
  assert.equal(r.code, 0, '已完工卡补 PR 号不该被拦,实际输出:' + r.out);
  assert.deepEqual(readTask(board, 'T1').prNumbers, [42]);
  clean(dir);
});

// ── ⑥ cost 的参数校验:不许把假数字记进账 ───────────────────────────────────
for (const [label, extra, pattern] of [
  ['裸 --rmb(没带数)', ['--rmb'], /--rmb/],
  ['负数 --rmb', ['--rmb', '-1'], /--rmb/],
  ['非数字 --rmb', ['--rmb', '两块钱'], /--rmb/],
  ['--credits 缺单位', ['--credits', '6209'], /--credit-unit/],
  ['--credit-unit 缺数字', ['--credit-unit', '积分'], /--credits/],
  ['裸 --credit-unit', ['--credits', '6209', '--credit-unit'], /--credit-unit/],
]) {
  test(`cost:${label} → 拒收,不留半条账`, () => {
    const { dir, reg, board } = setup();
    seedCard(reg, 'T1');
    const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'glm:1', ...extra);
    assert.notEqual(c.code, 0, '应拒收,实际 code=' + c.code + ' 输出:' + c.out);
    assert.match(c.out, pattern, '报错要指名是哪个参数不合格');
    assert.equal(readTask(board, 'T1').cost, undefined, '拒收时不许留下半条账');
    clean(dir);
  });
}

test('cost:--rmb 传 0 是合法的(真的花了 0 元与没取到是两件事,这里只管前者)', () => {
  const { dir, reg, board } = setup();
  seedCard(reg, 'T1');
  const c = cli(reg, 'cost', 'T1', '--project', 't', '--agents', 'main:1', '--rmb', '0');
  assert.equal(c.code, 0, '实际:' + c.out);
  assert.equal(readTask(board, 'T1').cost.entries[0].rmb, 0);
  assert.equal(cli(reg, 'done', 'T1', '--project', 't').code, 0, '¥0 也是一个量,应放行');
  clean(dir);
});
