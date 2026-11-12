'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { readOutbox } = require('../core/syncOutbox.cjs');
const { applyOp } = require('../core/syncReplay.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');

function fixture(t, cloud = false) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegated-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const projects = {};
  for (const id of ['demo', 'demo2']) {
    const root = path.join(dir, id); fs.mkdirSync(root);
    const board = path.join(root, 'board.json');
    const data = emptyBoard({ id, name: id, mainRepo: root });
    data.tasks = ['T1', 'T2', 'T3'].map(taskId => ({ id: taskId, title: taskId, status: '未开工', wave: 1 }));
    fs.writeFileSync(board, JSON.stringify(data));
    projects[id] = { name: id, mainRepo: root, board, ...(cloud && id === 'demo' ? { cloud: { enabled: true, remoteProjectId: 'remote' } } : {}) };
  }
  const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ projects }));
  const cli = (args, project = 'demo', cwd = dir) => spawnSync(process.execPath,
    [INDEX, ...args, ...(project ? ['--project', project] : []), '--registry', registry],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const read = id => JSON.parse(fs.readFileSync(projects[id].board, 'utf8'));
  const write = (id, board) => fs.writeFileSync(projects[id].board, JSON.stringify(board));
  return { dir, projects, registry, cli, read, write };
}
const args = (symptom = '按钮是灰的', task = 'T1', kind = '界面') =>
  ['delegate', task, '--kind', kind, '--symptom', symptom, '--chose', '改成可点', '--alt', '保持灰色'];
function ok(r) { assert.equal(r.status, 0, r.stderr || r.stdout || String(r.error)); return r; }

test('类别、短号和旧备注解析', () => {
  const d = require('../core/delegatedDecision.cjs');
  const aliases = { ui: ['界面', 'ui', '页面', '外观', '视觉'], gameplay: ['玩法与数值', 'gameplay', '玩法', '数值'], copy: ['文案', 'copy', '文字'], data: ['数据与口径', 'data', '数据', '口径'], external: ['对外', 'external', '外部'], tech: ['技术与流程', 'tech', '技术', '流程'] };
  for (const [key, values] of Object.entries(aliases)) for (const v of values) assert.equal(d.normalizeKind(' ' + v.toUpperCase() + ' ').key, key);
  assert.equal(d.normalizeKind('未知'), null);
  assert.equal(d.shortCode('demo', 'T1', 'ui', '按钮是灰的', '改成可点', '保持灰色'), '6091de');
  assert.equal(d.shortCode('demo', 'T1', 'copy', '提示太长', '改短', '保持原样'), 'c94a0a');
  assert.notEqual(d.shortCode('demo', 'T1', 'ui', '按钮是灰的', '改成可点', '保持灰色'), d.shortCode('demo', 'T1', 'ui', '按钮灰', '改成可点', '保持灰色'));
  for (const sep of ['|', '｜', ' | ']) {
    const row = d.parseDelegateNote(`【代定·界面】按钮是灰的${sep}改成可点${sep}保持灰色${sep}会审：同意`);
    assert.equal(row.kindKey, 'ui'); assert.equal(row.juror, '同意'); assert.equal(row.code, null);
    const records = d.collectDelegations('demo', [{ taskId: 'T1', text: `【代定·界面】按钮是灰的${sep}改成可点${sep}保持灰色` }]).records;
    assert.equal(records[0].code, '6091de');
  }
  assert.equal(d.parseDelegateNote('其他文字'), null);
  assert.equal(d.parseDelegateNote('【代定.其他#abcdef】一|二').kindKey, 'other');
  assert.equal(d.parseDelegateNote('【代定・界面#abcdef】一|二|三|四').alt, '三 | 四');
  assert.equal(d.parseDelegateNote('【代定・界面#ABCDEF】一|二|三|四|会审：五').alt, '三 | 四 | 会审：五');
  assert.equal(d.parseDelegateNote('【代定・界面#ABCDEF】一|二|三').code, 'ABCDEF');
  assert.equal(d.parseDelegateNote('【代定·界面#abcdef】一|二').code, 'abcdef');
  const field = { taskId: 'T1', kindKey: 'ui', symptom: '按钮是灰的', chose: '改成可点', alt: '保持灰色' };
  assert.deepEqual(d.pickShortCode('demo', [{ ...field, code: '6091de' }], field), { duplicate: '6091de' });
  assert.equal(d.pickShortCode('demo', [{ ...field, symptom: '其他', code: '6091de' }], field).length, 8);
  const written = d.collectDelegations('demo', [{ taskId: 'T1', text: '【代定·界面#abcdef】按钮是灰的|改成可点|保持灰色' }]).records[0];
  assert.equal(written.code, 'abcdef'); assert.equal(written.hasWrittenCode, true);
});

test('归档合并、去重、排序和损坏文件', t => {
  const f = fixture(t); const { readMergedActivity } = require('../core/activityArchive.cjs');
  const a = { ts: '2026-01-01', taskId: 'T1', text: '【代定·界面】甲|乙|丙' };
  const b = { ts: '2026-02-01', taskId: 'T2', text: '【代定·文案】丁|戊|己' };
  const board = f.read('demo'); board.activity = [b, a]; f.write('demo', board);
  const archive = path.join(f.projects.demo.mainRepo, 'activity-202601.json'); fs.writeFileSync(archive, JSON.stringify([a]));
  assert.deepEqual(readMergedActivity(f.projects.demo.board).map(x => x.text), [a.text, b.text]);
  fs.writeFileSync(archive, '{}'); assert.throws(() => readMergedActivity(f.projects.demo.board));
  assert.throws(() => readMergedActivity(path.join(f.dir, 'missing.json')), { code: 'ENOENT' });
});

test('项目级推翻与重号歧义', t => {
  const f = fixture(t); const board = f.read('demo');
  board.activity.push({ ts: '2026-01-01T00:00:00Z', taskId: null, text: '【代定·文案#abcdef】旧文字|改短|不改', type: 'note' });
  f.write('demo', board); ok(f.cli(['delegate', '--overturn', '#abcdef']));
  assert.equal(f.read('demo').activity.at(-1).taskId, null);
  const next = f.read('demo');
  next.activity.push({ ts: '2026-01-02T00:00:00Z', taskId: 'T1', text: '【代定·界面#123abc】甲|乙|丙', type: 'note' });
  next.activity.push({ ts: '2026-01-03T00:00:00Z', taskId: 'T2', text: '【代定·界面#123abc】丁|戊|己', type: 'note' });
  f.write('demo', next); const ambiguous = f.cli(['delegate', '--overturn', '123abc']);
  assert.equal(ambiguous.status, 1); assert.match(ambiguous.stderr, /T1/); assert.match(ambiguous.stderr, /T2/);
  ok(f.cli(['delegate', 'T1', '--overturn', '123abc']));
});

test('代定写备注、验证输入并按类别提示推翻次数', t => {
  const f = fixture(t); ok(f.cli([...args(), '--json']));
  const entry = f.read('demo').activity.at(-1);
  assert.equal(entry.type, 'note'); assert.equal(entry.kind, 'message'); assert.equal(entry.taskId, 'T1');
  assert.equal(entry.text, '【代定·界面#6091de】按钮是灰的 | 改成可点 | 保持灰色');
  for (const invalid of [args(), args('坏|输入'), args('坏｜输入'), args('坏\n输入'), [...args('甲'), '--juror', '甲|乙'], [...args('甲'), '--juror', '甲\n乙'], args('甲', 'T9'), ['delegate', 'T1'], args('甲', 'T1', '未知')]) {
    const before = fs.readFileSync(f.projects.demo.board, 'utf8');
    assert.equal(f.cli(invalid).status, 1); assert.equal(fs.readFileSync(f.projects.demo.board, 'utf8'), before);
  }
  const first = ok(f.cli(['delegate', '--overturn', '6091de', '--reason', '改回']));
  assert.doesNotMatch(first.stdout, /这一类在本项目已被推翻/);
  assert.equal(f.read('demo').activity.at(-1).text, '【推翻代定#6091de】改回');
  assert.equal(f.read('demo').activity.at(-1).taskId, 'T1');
  assert.equal(f.cli(['delegate', '--overturn', '6091de']).status, 1);
  assert.equal(f.cli(['delegate', '--overturn', 'ffffff']).status, 1);
  for (let n = 2; n <= 4; n++) {
    ok(f.cli(args('现象' + n)));
    const note = f.read('demo').activity.at(-1).text; const code = note.match(/#([a-f0-9]+)】/)[1];
    assert.equal(f.cli(['delegate', 'T2', '--overturn', code]).status, 1);
    const r = ok(f.cli(['delegate', '--overturn', code]));
    assert.equal(f.read('demo').activity.at(-1).text, `【推翻代定#${code}】（未写原因）`);
    if (n < 3) assert.doesNotMatch(r.stdout, /这一类在本项目已被推翻/);
    else assert.ok(r.stdout.includes(`这一类在本项目已被推翻 ${n} 次，请在回报里提一句，由负责人定这一类要不要改成先问；不自动改。`));
  }
});

test('出站队列是 note，重放正文一致', t => {
  const f = fixture(t, true); ok(f.cli(args())); ok(f.cli(['delegate', '--overturn', '6091de']));
  const ops = readOutbox(resolveProject('demo', { registryPath: f.registry }));
  assert.deepEqual(ops.map(x => x.command), ['note', 'note']);
  assert.match(ops[0].flags.text, /^【代定·.*#/);
  for (const op of ops) assert.equal(applyOp(op, { registryPath: f.registry, projectId: 'demo2' }).ok, true);
  assert.deepEqual(f.read('demo2').activity.map(x => x.text), ops.map(x => x.flags.text));
});

test('未启用同步时不创建队列', t => {
  const f = fixture(t); ok(f.cli(args())); ok(f.cli(['delegate', '--overturn', '6091de']));
  assert.equal(fs.existsSync(path.join(f.dir, 'sync')), false);
});

test('当前目录属于一个项目时仍搜索所有登记项目', t => {
  const f = fixture(t); ok(f.cli(args())); ok(f.cli(args('灰色按钮', 'T2'), 'demo2'));
  const init = spawnSync('git', ['init', '-q', f.projects.demo.mainRepo], { cwd: f.dir, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(init.status, 0, init.stderr);
  const result = JSON.parse(ok(f.cli(['delegated', '--search', '按钮', '--json'], null, f.projects.demo.mainRepo)).stdout);
  assert.equal(result.total, 2);
});

test('同类别统计与其他类别、其他项目互不混淆', t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) {
    ok(f.cli(args('按钮' + i)));
    const code = f.read('demo').activity.at(-1).text.match(/#([a-f0-9]+)】/)[1];
    ok(f.cli(['delegate', '--overturn', code]));
  }
  ok(f.cli(args('文字', 'T2', '文案'))); ok(f.cli(args('按钮', 'T1'), 'demo2'));
  const result = JSON.parse(ok(f.cli(['delegated', '--stats', '--kind', '页面', '--json'], null)).stdout);
  const demo = result.stats.find(x => x.project === 'demo');
  assert.equal(demo.total, 3); assert.equal(demo.overturned, 3); assert.equal(demo.hint, true);
  assert.equal(result.stats.find(x => x.project === 'demo2').overturned, 0);
  assert.ok(result.stats.every(x => x.kindKey === 'ui'));
  assert.match(ok(f.cli(['delegated', '--stats'], null)).stdout, /建议提一句：由负责人定是否改成先问/);
});

test('跨项目搜索、归档、筛选和统计', t => {
  const f = fixture(t); ok(f.cli(args())); ok(f.cli(args('灰色按钮', 'T2'), 'demo2'));
  const board = f.read('demo'); board.activity.push({ ts: '2026-01-01T00:00:00Z', taskId: 'T3', text: '【代定·文案】旧提示｜缩短｜保留', type: 'note' });
  f.write('demo', board); fs.writeFileSync(path.join(f.projects.demo.mainRepo, 'activity-202601.json'), JSON.stringify([board.activity.at(-1)]));
  const search = a => JSON.parse(ok(f.cli(['delegated', ...a, '--json'], null)).stdout);
  assert.equal(search(['--search', '灰', '按钮']).total, 2);
  assert.equal(search(['--search', '灰', '--search', '按钮']).total, 2);
  assert.equal(search(['--search', '旧提示']).total, 1);
  assert.equal(search(['--search', '灰', '--kind', '页面', '--limit', '1']).hits.length, 1);
  assert.equal(search(['--search', '不匹配']).total, 0);
  const stats = JSON.parse(ok(f.cli(['delegated', '--stats', '--json'], null)).stdout);
  assert.ok(stats.stats.some(s => s.project === 'demo' && s.kindKey === 'copy' && s.total === 1));
  assert.equal(f.cli(['delegated'], null).status, 1);
  assert.equal(f.cli(['delegated', '--search', '灰', '--stats'], null).status, 1);
  assert.equal(f.cli(['delegated', '--search', '灰', '--limit'], null).status, 1);
  assert.match(ok(f.cli(['delegated', '--search', '不存在'], null)).stdout, /没有找到/);
  ok(f.cli(['delegate', '--overturn', '6091de']));
  assert.match(ok(f.cli(['delegated', '--search', '按钮'], null)).stdout, /已推翻/);
  const local = JSON.parse(ok(f.cli(['delegated', '--search', '灰', '--json'], 'demo')).stdout);
  assert.ok(local.hits.every(hit => hit.project === 'demo'));
  const registry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
  registry.projects.missing = { name: 'missing', mainRepo: f.dir, board: path.join(f.dir, 'missing.json') };
  fs.writeFileSync(f.registry, JSON.stringify(registry));
  for (const query of [['--search', '灰'], ['--stats']]) assert.match(ok(f.cli(['delegated', ...query], null)).stdout, /跳过：missing/);
  assert.equal(f.cli(['delegated', '--stats'], 'missing').status, 1);
});
