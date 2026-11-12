'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { emptyBoard, validate } = require('../core/boardSchema.cjs');
const { applyOp, entryGateRefusal } = require('../core/syncReplay.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { readOutbox } = require('../core/syncOutbox.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const payload = { question: '采用哪个方案？', options: ['甲', '乙'], recommended: '甲',
  background: '说明本次选择的场景与问题以及影响。'.repeat(6),
  optionPros: { 甲: '好处是保持已有流程，代价是需要维护。'.repeat(2), 乙: '好处是引入新流程，代价是需要迁移。'.repeat(2) },
  recommendReason: '现有流程能够满足要求并减少迁移风险。'.repeat(3) };
function fixture(t, extra = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-fields-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const board = path.join(root, 'board.json'), registry = path.join(dir, 'registry.json');
  const data = emptyBoard({ id: 'demo', name: 'demo', mainRepo: root });
  data.tasks.push({ id: 'T1', title: '测试', status: '未开工', wave: 1 });
  fs.writeFileSync(board, JSON.stringify(data));
  const entry = { name: 'demo', mainRepo: root, board, ...extra };
  const register = () => fs.writeFileSync(registry, JSON.stringify({ projects: { demo: entry } })); register();
  const jsonFile = path.join(dir, 'pending.json'); fs.writeFileSync(jsonFile, JSON.stringify(payload));
  const cli = args => spawnSync(process.execPath, [INDEX, ...args, '--project', 'demo', '--registry', registry],
    { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const read = () => JSON.parse(fs.readFileSync(board, 'utf8'));
  return { dir, root, board, registry, entry, register, jsonFile, cli, read };
}
function ok(r) { assert.equal(r.status, 0, r.stderr || r.stdout || String(r.error)); return r; }

test('历史自由文本来源不阻碍同一块板上的新拍板', t => {
  const f = fixture(t);
  const board = f.read();
  board.tasks[0].decisions = [
    { id: 'd1', question: '旧问题', options: ['甲'], recommended: '甲', answer: '甲', decidedAt: '2026-01-01', decidedBy: '旧来源文字' },
    { id: 'd2', question: '新问题', options: ['甲', '乙'], recommended: '甲', answer: null, decidedAt: null },
  ];
  fs.writeFileSync(f.board, JSON.stringify(board));
  assert.equal(validate(board).ok, true);
  ok(f.cli(['decide', 'T1', '--did', 'd2', '--answer', '甲', '--by', 'owner']));
  assert.equal(f.read().tasks[0].decisions[0].decidedBy, '旧来源文字');
  assert.equal(f.read().tasks[0].decisions[1].decidedBy, 'owner');
});

test('新的未知来源被拒且板文件不变', t => {
  const f = fixture(t);
  ok(f.cli(['pending', 'T1', '--json-file', f.jsonFile]));
  const before = fs.readFileSync(f.board);
  assert.equal(f.cli(['decide', 'T1', '--did', 'd1', '--answer', '甲', '--by', '未知来源']).status, 1);
  assert.deepEqual(fs.readFileSync(f.board), before);
});

test('类别别名与授权页判定', t => {
  const f = fixture(t); const d = require('../core/delegatedDecision.cjs');
  const aliases = { goal: ['改目标', '目标'], spend: ['花钱超线', '花钱', '超线', '预算'], irreversible: ['收不回的事', '收不回', '不可逆'], 'owner-only': ['要他本人做', '本人', '他本人'], taste: ['口味题', '口味'], rule: ['改规矩', '规矩', '规则'] };
  for (const [key, values] of Object.entries(aliases)) for (const v of [key.toUpperCase(), ...values]) assert.equal(d.normalizeAskKind(v), key);
  for (const v of ['owner', '负责人', '负责人拍板']) assert.equal(d.normalizeDecidedBy(v), 'owner');
  for (const v of ['delegated', '对话代定', '代定']) assert.equal(d.normalizeDecidedBy(v), 'delegated');
  assert.equal(d.normalizeAskKind('未知'), null); assert.equal(d.normalizeDecidedBy('未知'), null);
  assert.equal(d.isDelegatedProject(f.entry), false);
  fs.mkdirSync(path.join(f.root, 'docs')); fs.writeFileSync(path.join(f.root, 'docs', '授权页.md'), '授权');
  assert.equal(d.isDelegatedProject(f.entry), true);
  assert.equal(d.isDelegatedProject({ ...f.entry, delegatedDecision: false }), false);
  assert.equal(d.isDelegatedProject({ mainRepo: path.join(f.dir, 'missing'), codeRepo: f.root }), true);
  assert.equal(d.isDelegatedProject({ mainRepo: f.root, codeRepo: path.join(f.dir, 'missing') }), true);
  assert.equal(d.isDelegatedProject({ mainRepo: path.join(f.dir, 'missing') }), false);
  assert.equal(d.isDelegatedProject({ delegatedDecision: true }), true);
});

test('三种输入均保存稳定键且 JSON 值优先', t => {
  const f = fixture(t, { delegatedDecision: true });
  fs.writeFileSync(f.jsonFile, JSON.stringify({ ...payload, askKind: '花钱' }));
  ok(f.cli(['pending', 'T1', '--json-file', f.jsonFile, '--ask-kind', 'goal']));
  assert.equal(f.read().tasks[0].decisions[0].askKind, 'spend');
  fs.writeFileSync(f.jsonFile, JSON.stringify(payload));
  ok(f.cli(['pending', 'T1', '--json-file', f.jsonFile, '--ask-kind', '口味题']));
  assert.equal(f.read().tasks[0].decisions[1].askKind, 'taste');
  const args = [INDEX, 'pending', 'T1', '--json', '--project', 'demo', '--registry', f.registry];
  const r = spawnSync(process.execPath, args, { cwd: f.dir, windowsHide: true, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ ...payload, askKind: 'irreversible' }) });
  ok(r); assert.equal(f.read().tasks[0].decisions[2].askKind, 'irreversible');
  assert.equal(f.cli(['decide', 'T1', '--did', 'd1', '--answer', '甲', '--by']).status, 1);
});

test('本机入口强制类别，直接调用和重放只检查值域', t => {
  const f = fixture(t, { delegatedDecision: true });
  const pending = ['pending', 'T1', '--json-file', f.jsonFile];
  const missing = f.cli(pending); assert.equal(missing.status, 1); assert.match(missing.stderr, /自己定，用 delegate 留一行/);
  for (const s of ['改目标', '花钱超线', '收不回的事', '要他本人做', '口味题', '改规矩']) assert.ok(missing.stderr.includes(s));
  assert.equal(f.cli([...pending, '--ask-kind', '未知']).status, 1);
  ok(f.cli([...pending, '--ask-kind', '目标'])); assert.equal(f.read().tasks[0].decisions[0].askKind, 'goal');
  const unmarked = ok(f.cli(['decide', 'T1', '--did', 'd1', '--answer', '甲']));
  assert.match(unmarked.stdout, /没写 --by，这条记为未标/);
  assert.equal(Object.hasOwn(f.read().tasks[0].decisions[0], 'decidedBy'), false);
  const flags = { _: ['T1'], project: 'demo', registry: f.registry, 'json-file': f.jsonFile };
  assert.equal(entryGateRefusal('pending', flags), null);
  const cmds = require('../cli/commands.cjs');
  cmds.pending(flags); assert.throws(() => cmds.pending({ ...flags, 'ask-kind': '未知' }));
  assert.equal(applyOp({ kind: 'op', command: 'pending', flags: { _: ['T1'], 'json-file': 'input' }, files: { 'json-file': JSON.stringify(payload) } }, { registryPath: f.registry, projectId: 'demo' }).ok, true);
  assert.equal(applyOp({ kind: 'op', command: 'decide', flags: { _: ['T1'], did: 'd3', answer: '甲' }, files: {} }, { registryPath: f.registry, projectId: 'demo' }).ok, true);
});

test('未接入项目兼容旧调用，显式登记覆盖授权页', t => {
  const f = fixture(t); const pending = ['pending', 'T1', '--json-file', f.jsonFile];
  ok(f.cli(pending)); const r = ok(f.cli(['decide', 'T1', '--did', 'd1', '--answer', '甲']));
  assert.doesNotMatch(r.stdout, /没写 --by/);
  fs.mkdirSync(path.join(f.root, 'docs')); fs.writeFileSync(path.join(f.root, 'docs', '授权页.md'), '授权');
  f.entry.delegatedDecision = false; f.register(); ok(f.cli(pending));
  f.entry.delegatedDecision = true; f.register(); assert.equal(f.cli(pending).status, 1);
});

test('决定来源、撤销和云端出站参数', t => {
  const f = fixture(t, { delegatedDecision: true, cloud: { enabled: true, remoteProjectId: 'remote' } });
  for (const [i, by] of ['owner', '负责人', 'delegated', '对话代定'].entries()) {
    ok(f.cli(['pending', 'T1', '--json-file', f.jsonFile, '--ask-kind', 'rule']));
    ok(f.cli(['decide', 'T1', '--did', 'd' + (i + 1), '--answer', '甲', '--by', by]));
    assert.equal(f.read().tasks[0].decisions[i].decidedBy, i < 2 ? 'owner' : 'delegated');
  }
  assert.equal(f.cli(['decide', 'T1', '--did', 'd1', '--answer', '甲', '--by', '未知']).status, 1);
  assert.equal(readOutbox(resolveProject('demo', { registryPath: f.registry })).filter(x => x.command === 'decide')[0].flags.by, 'owner');
  ok(f.cli(['undecide', 'T1', '--did', 'd1']));
  const d = f.read().tasks[0].decisions[0]; assert.equal(d.askKind, 'rule'); assert.equal(Object.hasOwn(d, 'decidedBy'), false);
});

test('旧决定可校验，新字段非法时被拒，网页入口标记负责人', t => {
  const f = fixture(t); ok(f.cli(['pending', 'T1', '--json-file', f.jsonFile]));
  const board = f.read(); assert.equal(validate(board).ok, true);
  ok(f.cli(['show', 'T1'])); ok(f.cli(['list']));
  board.tasks[0].decisions[0].askKind = 'invalid'; assert.equal(validate(board).ok, false);
  delete board.tasks[0].decisions[0].askKind; board.tasks[0].decisions[0].decidedBy = 123; assert.equal(validate(board).ok, false);
  const server = fs.readFileSync(path.join(__dirname, '../server/server.cjs'), 'utf8');
  const start = server.indexOf('function handleDecide'); assert.ok(start >= 0);
  assert.match(server.slice(start, start + 2500), /['"]--by['"]\s*,\s*['"]owner['"]/);
});
