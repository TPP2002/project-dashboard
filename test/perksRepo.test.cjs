'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPerksRepoFinder, PERKS_REPO_MARKERS } = require('../server/perksRepo.cjs');

const M = ['src/cli.ts', 'src/control.ts', 'src/panel/launch.ts'];

// 测试里的目录一律用临时目录下的假名字拼出来，靠注入的 fileExists 判定「文件在不在」，
// 不写任何真实本机路径，也不真的去碰磁盘。
function fakeDir(name) {
  return path.join(os.tmpdir(), name);
}

// entries: [目录, 该目录里存在的标记数组]，构造一个只认这些路径的 fileExists。
function existsFor(entries) {
  const set = new Set();
  for (const [dir, markers] of entries) {
    const base = path.resolve(dir);
    for (const m of markers) set.add(path.join(base, m));
  }
  return (p) => set.has(p);
}

// 一、环境变量是非空绝对路径时直接返回它，且 codexRepo、readRegistry、fileExists 一次都没被调。
test('一 环境变量绝对路径直接返回，三个依赖都不查', () => {
  let codexCalls = 0, registryCalls = 0, fileCalls = 0;
  const override = fakeDir('fake-env-absolute');
  const finder = createPerksRepoFinder({
    codexRepo: () => { codexCalls++; return null; },
    readRegistry: () => { registryCalls++; return { projects: {} }; },
    fileExists: () => { fileCalls++; return false; },
    env: { DASHBOARD_PERKS_REPO: override },
  });
  assert.equal(finder.resolve(), override);
  assert.equal(codexCalls, 0);
  assert.equal(registryCalls, 0);
  assert.equal(fileCalls, 0);
});

// 二、环境变量为空串、全是空格、相对路径时不算数，继续往下走到扫描。
test('二 环境变量空串、全空格、相对路径都不算，继续往下走', () => {
  const found = fakeDir('fake-env-fallback');
  const fileExists = existsFor([[found, M]]);
  const readRegistry = () => ({ schemaVersion: '1.0', projects: { p: { mainRepo: found } } });
  for (const badEnv of ['', '   ', 'fake-relative/path']) {
    const finder = createPerksRepoFinder({
      codexRepo: () => null, readRegistry, fileExists,
      env: { DASHBOARD_PERKS_REPO: badEnv }, now: () => 1000, cacheMs: 60000,
    });
    assert.equal(finder.resolve(), path.resolve(found));
  }
});

// 三、codexRepo('perks') 返回字符串时返回它，readRegistry 不被调，传给 codexRepo 的参数是 'perks'。
test('三 codexRepo 返回字符串时返回它且参数是 perks，readRegistry 不查', () => {
  let arg = null, registryCalls = 0;
  const sentinel = fakeDir('fake-step-two');
  const finder = createPerksRepoFinder({
    codexRepo: (id) => { arg = id; return sentinel; },
    readRegistry: () => { registryCalls++; return { projects: {} }; },
    fileExists: () => false, env: {},
  });
  assert.equal(finder.resolve(), sentinel);
  assert.equal(arg, 'perks');
  assert.equal(registryCalls, 0);
});

// 四、项目甲只有 mainRepo（三个文件不全），项目乙的 costRoots 第二项三个文件齐全，返回乙的那一项。
test('四 扫描：项目甲 mainRepo 不全，项目乙 costRoots 第二项齐全', () => {
  const incomplete = fakeDir('fake-scan-a-incomplete');
  const other = fakeDir('fake-scan-b-other');
  const complete = fakeDir('fake-scan-b-complete');
  const fileExists = existsFor([
    [incomplete, [M[0], M[1]]],
    [other, [M[0]]],
    [complete, M],
  ]);
  const readRegistry = () => ({ schemaVersion: '1.0', projects: {
    alpha: { mainRepo: incomplete },
    beta: { costRoots: [other, complete] },
  } });
  const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
  assert.equal(finder.resolve(), path.resolve(complete));
});

// 五、三个文件缺任何一个都不算（缺每一个各一例）。
test('五 三个标记缺任何一个都不算', () => {
  for (let i = 0; i < M.length; i++) {
    const dir = fakeDir('fake-miss-' + i);
    const fileExists = existsFor([[dir, M.filter((_, j) => j !== i)]]);
    const readRegistry = () => ({ projects: { p: { mainRepo: dir } } });
    const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
    assert.equal(finder.resolve(), null, '缺 ' + M[i] + ' 应返回 null');
  }
});

// 六、同一个项目里 mainRepo/codeRepo/costRoots 都齐全时返回 mainRepo；两个项目都齐全时返回排在前面的项目的。
test('六 顺序：项目内取 mainRepo，项目间取靠前的项目', () => {
  const a = fakeDir('fake-order-main');
  const b = fakeDir('fake-order-code');
  const c = fakeDir('fake-order-cost');
  const d = fakeDir('fake-order-second');
  const fileExists = existsFor([[a, M], [b, M], [c, M], [d, M]]);
  {
    const readRegistry = () => ({ projects: { p: { mainRepo: a, codeRepo: b, costRoots: [c] } } });
    const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
    assert.equal(finder.resolve(), path.resolve(a));
  }
  {
    const readRegistry = () => ({ projects: { first: { mainRepo: a }, second: { mainRepo: d } } });
    const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
    assert.equal(finder.resolve(), path.resolve(a));
  }
});

// 七、候选里的相对路径、空串、非字符串被跳过，不拿去查文件。
test('七 相对路径、空串、非字符串候选被跳过，不查文件', () => {
  const valid = fakeDir('fake-valid-candidate');
  const baseExists = existsFor([[valid, M]]);
  const calls = [];
  const fileExists = (p) => { calls.push(p); return baseExists(p); };
  const readRegistry = () => ({ projects: {
    bad: { mainRepo: 'fake-relative/path', codeRepo: '', costRoots: [123, null, 'fake-relative-2', {}, undefined] },
    good: { mainRepo: valid },
  } });
  const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
  assert.equal(finder.resolve(), path.resolve(valid));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => !c.includes('fake-relative')));
});

// 八、同一个目录在多个项目里出现只查一遍（Windows 上大小写不同也算同一个）。
test('八 同一目录在多个项目里出现只查一遍（win32 含大小写）', { skip: process.platform !== 'win32' && '大小写去重的断言只在 win32 上验证' }, () => {
  const dirA = fakeDir('fake-dedup');
  const dirB = dirA.toUpperCase();
  const calls = [];
  const fileExists = (p) => {
    calls.push(p);
    return path.basename(p) !== 'launch.ts'; // 故意缺第三个标记，保证不提前命中
  };
  const readRegistry = () => ({ projects: {
    p1: { mainRepo: dirA },
    p2: { mainRepo: dirB },
  } });
  const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists, env: {} });
  assert.equal(finder.resolve(), null);
  assert.equal(calls.length, 3, '同一目录只应被查一次（三个标记各一次）');
});

// 九、一个都没有时返回 null。
test('九 一个都没有时返回 null', () => {
  const readRegistry = () => ({ projects: {
    a: { mainRepo: fakeDir('fake-none-a') },
    b: { costRoots: [fakeDir('fake-none-b')] },
  } });
  const finder = createPerksRepoFinder({ codexRepo: () => null, readRegistry, fileExists: () => false, env: {} });
  assert.equal(finder.resolve(), null);
});

// 十、缓存：命中时不重复扫，拨过 cacheMs 重新扫。
test('十 缓存：命中不重复扫，拨过 cacheMs 重新扫', () => {
  let clock = 1000;
  const found = fakeDir('fake-cache-found');
  const baseExists = existsFor([[found, M]]);
  let registryCalls = 0, fileCalls = 0;
  const readRegistry = () => { registryCalls++; return { projects: { p: { mainRepo: found } } }; };
  const fileExists = (p) => { fileCalls++; return baseExists(p); };
  const finder = createPerksRepoFinder({
    codexRepo: () => null, readRegistry, fileExists, env: {}, now: () => clock, cacheMs: 60000,
  });
  const r1 = finder.resolve();
  assert.equal(r1, path.resolve(found));
  assert.equal(registryCalls, 1);
  assert.equal(fileCalls, 3);
  const r2 = finder.resolve();
  assert.equal(r2, r1);
  assert.equal(registryCalls, 1);
  assert.equal(fileCalls, 3);
  clock += 60000 + 1;
  const r3 = finder.resolve();
  assert.equal(r3, r1);
  assert.equal(registryCalls, 2);
});

// 十、找不到（null）的结果同样被缓存。
test('十 缓存：找不到（null）的结果同样被缓存', () => {
  let clock = 1000;
  let registryCalls = 0;
  const readRegistry = () => { registryCalls++; return { projects: { p: { mainRepo: fakeDir('fake-cache-null') } } }; };
  const finder = createPerksRepoFinder({
    codexRepo: () => null, readRegistry, fileExists: () => false, env: {}, now: () => clock, cacheMs: 60000,
  });
  assert.equal(finder.resolve(), null);
  assert.equal(registryCalls, 1);
  assert.equal(finder.resolve(), null);
  assert.equal(registryCalls, 1);
  clock += 60000 + 1;
  assert.equal(finder.resolve(), null);
  assert.equal(registryCalls, 2);
});

// 十一、缓存不挡甲和乙：扫描结果缓存着时环境变量和 codex 仍现判。
test('十一 缓存不挡甲和乙', () => {
  let clock = 1000;
  const found = fakeDir('fake-block-found');
  const baseExists = existsFor([[found, M]]);
  let registryCalls = 0;
  const readRegistry = () => { registryCalls++; return { projects: { p: { mainRepo: found } } }; };
  const env = {};
  let codexResult = null;
  const finder = createPerksRepoFinder({
    codexRepo: () => codexResult, readRegistry, fileExists: baseExists, env, now: () => clock, cacheMs: 60000,
  });
  assert.equal(finder.resolve(), path.resolve(found));
  assert.equal(registryCalls, 1);
  const override = fakeDir('fake-block-override');
  env.DASHBOARD_PERKS_REPO = override;
  assert.equal(finder.resolve(), override);
  assert.equal(registryCalls, 1);
  env.DASHBOARD_PERKS_REPO = '';
  const codexPath = fakeDir('fake-block-codex');
  codexResult = codexPath;
  assert.equal(finder.resolve(), codexPath);
  assert.equal(registryCalls, 1);
});

// 十二、坏形状不抛：readRegistry 抛异常/返回 null/projects 是数组/项目值是 null/costRoots 是字符串/
//       fileExists 抛异常/codexRepo 抛异常，resolve 都返回 null 或后面正常找到的结果。
test('十二 坏形状不抛，返回 null 或后面正常找到的结果', () => {
  const good = fakeDir('fake-shape-good');
  const baseExists = existsFor([[good, M]]);
  const noop = () => false;
  const mk = (over) => createPerksRepoFinder(Object.assign({
    codexRepo: () => null, readRegistry: () => ({ projects: {} }), fileExists: noop, env: {},
  }, over)).resolve;
  assert.equal(mk({ readRegistry: () => { throw new Error('boom'); } })(), null);
  assert.equal(mk({ readRegistry: () => null })(), null);
  assert.equal(mk({ readRegistry: () => ({ projects: [] }) })(), null);
  assert.equal(mk({ readRegistry: () => ({ projects: { a: null } }) })(), null);
  assert.equal(mk({ readRegistry: () => ({ projects: { a: { mainRepo: null, costRoots: 'not-an-array' } } }) })(), null);
  assert.equal(mk({ readRegistry: () => ({ projects: { a: { mainRepo: fakeDir('fake-shape-x') } } }), fileExists: () => { throw new Error('boom'); } })(), null);
  assert.equal(mk({ codexRepo: () => { throw new Error('boom'); }, readRegistry: () => ({ projects: { p: { mainRepo: good } } }), fileExists: baseExists })(), path.resolve(good));
  // 混合坏形状，且 fileExists 在第一个目录抛异常，后面仍应正常找到。
  const badDir = fakeDir('fake-shape-throw');
  const fileExists = (p) => {
    if (p.startsWith(path.resolve(badDir))) throw new Error('boom');
    return baseExists(p);
  };
  const readRegistry = () => ({ projects: {
    a: null,
    b: { costRoots: 'not-an-array', mainRepo: 123 },
    c: { mainRepo: 'fake-relative/nope' },
    d: { mainRepo: badDir },
    e: { mainRepo: good },
  } });
  assert.equal(mk({ readRegistry, fileExists })(), path.resolve(good));
});

// 十三、源码接线：server.cjs 引入新模块，且 resolvePerksRepo 函数体里不再直接出现 codexRepo('perks')。
test('十三 源码接线：引入新模块且函数体不再直接调 codexRepo(perks)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.cjs'), 'utf8');
  assert.ok(text.includes("require('./perksRepo.cjs')"));
  assert.ok(!text.includes("codexRepo('perks')"), '不应再有 codexRepo(perks) 的直接调用');
  const start = text.indexOf('function resolvePerksRepo');
  assert.ok(start >= 0, '找不到 resolvePerksRepo 函数');
  const body = text.slice(start, text.indexOf('\n}', start));
  assert.ok(!body.includes("codexRepo('perks')"), '函数体里不应再直接调用 codexRepo(perks)');
});

// 十四、PERKS_REPO_MARKERS 恰好是那三个路径。
test('十四 PERKS_REPO_MARKERS 恰好是那三个路径', () => {
  assert.deepEqual(PERKS_REPO_MARKERS, ['src/cli.ts', 'src/control.ts', 'src/panel/launch.ts']);
});
