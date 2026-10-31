'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveProject } = require('../core/resolveProject.cjs');

test('resolveProject 解析注册项目（board 默认落 <root>/.dashboard）', () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  const reg = path.join(d, 'registry.json');
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: { game: { name: '示例项目·模拟器', mainRepo: repo } } }));
  const r = resolveProject('game', { registryPath: reg });
  assert.strictEqual(r.mainRepo, repo);
  assert.strictEqual(r.board, path.join(repo, '.dashboard', 'board.json'));
  assert.strictEqual(r.lock, r.board + '.lock');
  fs.rmSync(d, { recursive: true, force: true });
});

test('未注册项目报错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const reg = path.join(d, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  assert.throws(() => resolveProject('nope', { registryPath: reg }), /未注册/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('缺 --project 报错（禁 cwd 猜）', () => {
  assert.throws(() => resolveProject('', {}), /--project/);
});

test('costRoots:缺省、非数组和空数组都只回落 mainRepo,不混入 codeRepo', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const reg = path.join(d, 'registry.json');
  const mainRepo = path.join(d, 'board-home');
  const codeRepo = path.join(d, 'code-repo');
  for (const costRoots of [undefined, null, 'not-an-array', {}, []]) {
    fs.writeFileSync(reg, JSON.stringify({ projects: { cluster: { mainRepo, codeRepo, costRoots } } }));
    const r = resolveProject('cluster', { registryPath: reg });
    assert.deepEqual(r.costRoots, [mainRepo], '没登记清单时必须维持原 mainRepo 口径');
  }
});

test('costRoots:显式清单解 junction、规范化并按登记顺序去重', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const reg = path.join(d, 'registry.json');
  const first = path.join(d, 'z-desk');
  const second = path.join(d, 'a-desk');
  const alias = path.join(d, 'desk-alias');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.symlinkSync(first, alias, 'junction');
  fs.writeFileSync(reg, JSON.stringify({ projects: { cluster: {
    mainRepo: d, costRoots: [first + path.sep + '.', second, alias, second + path.sep],
  } } }));
  assert.deepEqual(resolveProject('cluster', { registryPath: reg }).costRoots, [first, second]);
});

test('costRoots:登记尚不存在的多级工位目录也能解析', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const reg = path.join(d, 'registry.json');
  const future = path.join(d, 'not-created', 'desk');
  fs.writeFileSync(reg, JSON.stringify({ projects: { cluster: { mainRepo: d, costRoots: [future] } } }));
  assert.equal(fs.existsSync(future), false);
  assert.deepEqual(resolveProject('cluster', { registryPath: reg }).costRoots, [future]);
});

test('costPrefixRoots:mainRepo 是 junction、不写 costRoots 时,原写法与真实路径两种都保留(既有 costRoots 测试一字未动)', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => {
    const alias = path.join(d, 'alias');
    fs.rmSync(alias, { force: true });
    fs.rmSync(path.join(d, 'real'), { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  });
  const reg = path.join(d, 'registry.json');
  const real = path.join(d, 'real');
  const alias = path.join(d, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, 'junction');
  fs.writeFileSync(reg, JSON.stringify({ projects: { moved: { mainRepo: alias } } }));
  const r = resolveProject('moved', { registryPath: reg });
  // costRoots 维持原口径:解联接、只认真实路径
  assert.deepEqual(r.costRoots, [real]);
  // costPrefixRoots:真实路径在前,登记原写法(联接路径)在后,去重保序
  assert.deepEqual(r.costPrefixRoots, [real, alias]);
});

test('costPrefixRoots:costRoots 显式登记 junction 时,真实路径与登记原写法逐项并列', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => {
    const alias = path.join(d, 'alias');
    fs.rmSync(alias, { force: true });
    fs.rmSync(path.join(d, 'real'), { recursive: true, force: true });
    fs.rmSync(path.join(d, 'other'), { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  });
  const reg = path.join(d, 'registry.json');
  const real = path.join(d, 'real');
  const alias = path.join(d, 'alias');
  const other = path.join(d, 'other');
  fs.mkdirSync(real);
  fs.mkdirSync(other);
  fs.symlinkSync(real, alias, 'junction');
  fs.writeFileSync(reg, JSON.stringify({ projects: { moved: { mainRepo: d, costRoots: [alias, other] } } }));
  const r = resolveProject('moved', { registryPath: reg });
  assert.deepEqual(r.costRoots, [real, other]);
  assert.deepEqual(r.costPrefixRoots, [real, alias, other]);
});

test('costPrefixRoots:无 junction 的项目与 costRoots 逐项相等', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const reg = path.join(d, 'registry.json');
  const repo = path.join(d, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(reg, JSON.stringify({ projects: { plain: { mainRepo: repo } } }));
  const r = resolveProject('plain', { registryPath: reg });
  assert.deepEqual(r.costRoots, [repo]);
  assert.deepEqual(r.costPrefixRoots, r.costRoots);
});

test('costRoots:丢弃非字符串和空串,过滤后为空则回落 mainRepo', (t) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const reg = path.join(d, 'registry.json');
  const desk = path.join(d, 'desk');
  const invalid = [null, 3, false, {}, [], '', '   '];
  fs.writeFileSync(reg, JSON.stringify({ projects: { cluster: { mainRepo: d, costRoots: [...invalid, desk] } } }));
  assert.deepEqual(resolveProject('cluster', { registryPath: reg }).costRoots, [desk]);
  fs.writeFileSync(reg, JSON.stringify({ projects: { cluster: { mainRepo: d, costRoots: invalid } } }));
  assert.deepEqual(resolveProject('cluster', { registryPath: reg }).costRoots, [d], '过滤后为空必须回落 mainRepo');
});
