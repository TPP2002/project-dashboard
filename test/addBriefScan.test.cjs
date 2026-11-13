'use strict';
// AD-20261111-BRIEF-SCAN：接了代理决策的项目（主仓有 docs/授权页.md）建卡、存收单指令时先过 briefScan。
// 仿 addPlainTitleGate.test.cjs 的写法：跑真 CLI 入口，项目主仓建在临时目录里。
// 没接代理决策的项目一律不扫，行为与加这道闸之前逐字节相同（B1③）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const INDEX = path.join(__dirname, '..', 'cli', 'index.cjs');

/** 临时项目：注册一块板；adopted=true 时主仓里放 docs/授权页.md（= 接了代理决策）。 */
function setup({ adopted = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'abs-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  if (adopted) {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', '授权页.md'), '授权');
  }
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, reg, root, board: path.join(root, '.dashboard', 'board.json') };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发句柄滞留 */ } };
const readBoard = (board) => JSON.parse(fs.readFileSync(board, 'utf8'));

/** 跑真 CLI 入口，返回 {code, out} */
function cli(reg, ...args) {
  try {
    const out = execFileSync('node', [INDEX, ...args, '--registry', reg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const CARD = ['--title', '正常的技术说明：把闸接到建卡路径', '--plain-title', '建卡时会先查一遍有没有要人拍板的句子', '--model', 'sonnet·低'];
const ASK_HIT = '分解产出后停下等负责人拍板开工。';

test('B1① 主仓接了代理决策：add 的 desc 夹带等负责人拍板 → 拒收并打印原句与改法，板上没有这张卡', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', ASK_HIT);
  assert.notEqual(r.code, 0, '命中应拒收，实际 code=' + r.code + '，输出:' + r.out);
  assert.ok(r.out.includes(ASK_HIT), '要把命中的原句打出来，输出:' + r.out);
  assert.ok(r.out.includes('六类'), '要给出改法（六类），输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 0, '拒收时不应建卡');
  clean(dir);
});

test('B1② 同样命中但加 --allow-ask "测试误拦" → 建卡成功，动态里记下放行理由', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', ASK_HIT, '--allow-ask', '测试误拦');
  assert.equal(r.code, 0, '放行后应建卡成功，输出:' + r.out);
  const b = readBoard(board);
  assert.equal((b.tasks || []).length, 1);
  const notes = (b.activity || []).filter((a) => a.taskId === 'C1');
  assert.ok(notes.some((a) => String(a.text).includes('测试误拦')), '新建记录的动态里要带放行理由');
  clean(dir);
});

test('B1③ 主仓没接代理决策（没有 docs/授权页.md）：同样的 desc 照常建卡，无扫描相关输出', () => {
  const { dir, reg, board } = setup({ adopted: false });
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', ASK_HIT);
  assert.equal(r.code, 0, '没接代理决策的项目绝不能被拦，输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 1);
  assert.ok(!/扫描放行|六类|确属误拦/.test(r.out), '不该有扫描相关输出，输出:' + r.out);
  clean(dir);
});

test('B1④ desc 只有「收官后发版。」且没引原话日期 → 按卡面风险拒收', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', '收官后发版。');
  assert.notEqual(r.code, 0, '卡面风险应拒收，输出:' + r.out);
  assert.ok(r.out.includes('发版'), '要打出命中的原句，输出:' + r.out);
  assert.ok(r.out.includes('原话'), '要说明缺负责人原话，输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 0);
  clean(dir);
});

test('B1⑤ 批量建卡：三张里有一张命中 → 整批拒收、一张不留，报错指明是哪张卡', () => {
  const { dir, reg, board, root } = setup();
  const cards = [
    { id: 'B1', title: '第一张：把闸接进建卡', plainTitle: '第一张卡的普通说明', model: 'sonnet·低', desc: '正常的一句话。' },
    { id: 'B2', title: '第二张：把闸接进收单指令', plainTitle: '第二张卡的普通说明', model: 'sonnet·低', desc: '有冲突立刻停下问负责人。' },
    { id: 'B3', title: '第三张：补回归测试', plainTitle: '第三张卡的普通说明', model: 'sonnet·低', desc: '也是正常的一句话。' },
  ];
  const file = path.join(root, 'cards.json');
  fs.writeFileSync(file, JSON.stringify(cards));
  const r = cli(reg, 'add', '--project', 't', '--json-file', file);
  assert.notEqual(r.code, 0, '整批应拒收，输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 0, '整批拒收时一张都不该建');
  assert.ok(r.out.includes('B2'), '报错要指明是哪张卡，输出:' + r.out);
  clean(dir);
});

test('B1⑥ collect-brief 的指令命中 → 拒收且卡上 collectBrief 不变；加 --allow-ask 存成功', () => {
  const { dir, reg, board } = setup();
  const created = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', '正常的一句话。');
  assert.equal(created.code, 0, '先要有一张卡，输出:' + created.out);
  const hit = '有冲突立刻停下问负责人。';
  const rejected = cli(reg, 'collect-brief', 'C1', '--project', 't', '--text', hit);
  assert.notEqual(rejected.code, 0, '命中应拒收，输出:' + rejected.out);
  assert.ok(rejected.out.includes(hit), '要把命中的原句打出来，输出:' + rejected.out);
  assert.equal(readBoard(board).tasks[0].collectBrief, undefined, '拒收时卡上 collectBrief 不能变');
  const allowed = cli(reg, 'collect-brief', 'C1', '--project', 't', '--text', hit, '--allow-ask', '测试误拦');
  assert.equal(allowed.code, 0, '放行后应存成功，输出:' + allowed.out);
  const b = readBoard(board);
  assert.equal(b.tasks[0].collectBrief.text, hit);
  assert.ok((b.activity || []).some((a) => String(a.text).includes('测试误拦')), '动态里要记下放行理由');
  clean(dir);
});

test('B1⑦ desc「不用先问负责人,直接做。」是明确的否定句 → 建卡成功', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD, '--desc', '不用先问负责人,直接做。');
  assert.equal(r.code, 0, '否定句不该拦，输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 1);
  clean(dir);
});

test('B1⑧ 主仓接了代理决策:desc 写游戏里的买卖和停下报告 → 照常建卡', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'C1', '--project', 't', ...CARD,
    '--desc', '玩家花钱买情报提前躲雷，成交流水显示手续费。对契约未覆盖的机制选择停下报告，不扩面。');
  assert.equal(r.code, 0, '游戏里的买卖与停下报告都不该被拦，输出:' + r.out);
  assert.equal((readBoard(board).tasks || []).length, 1);
  assert.ok(!r.out.includes('六类'), '输出不该有六类改法，输出:' + r.out);
  assert.ok(!r.out.includes('原话'), '输出不该要求负责人原话，输出:' + r.out);
  clean(dir);
});
