'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('每日福利页面和接口已接入', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of ['web/src/api/perks.ts', 'web/src/utils/perksFormat.ts', 'web/src/components/resources/PerksPanel.vue']) {
    assert.ok(fs.existsSync(path.join(root, file)), `缺少 ${file}`);
  }
  const view = fs.readFileSync(path.join(root, 'web/src/views/ResourceAccounts.vue'), 'utf8');
  assert.match(view, /每日福利/);
});

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function harness() {
  const req = require('node:module').createRequire(path.join(ROOT, 'web/package.json'));
  const ts = req('typescript');
  const { parse, compileScript, compileTemplate } = req('vue/compiler-sfc');
  const { createSSRApp, h } = req('vue');
  const { renderToString } = req('vue/server-renderer');
  function evaluate(source, deps = {}) {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(id => Object.hasOwn(deps, id) ? deps[id] : req(id), module, module.exports);
    return module.exports;
  }
  const resources = evaluate(read('web/src/utils/resourcesFormat.ts'));
  const format = evaluate(read('web/src/utils/perksFormat.ts'), { './resourcesFormat': resources });
  const filename = 'web/src/components/resources/PerksPanel.vue';
  const { descriptor, errors } = parse(read(filename), { filename });
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: 'perks' });
  const template = compileTemplate({ id: 'perks', filename, source: descriptor.template.content, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const deps = { '@/utils/perksFormat': format };
  const component = evaluate(script.content, deps).default;
  component.render = evaluate(template.code, deps).render;
  async function render(patch = {}) {
    const props = { status: 'ready', data: state(), errorLine: '', line: format.statusLine(state(), 0, ''), acting: false, accountNote: '', ...patch };
    return renderToString(createSSRApp({ render: () => h(component, props) }));
  }
  return { format, render };
}
function state(patch = {}) {
  return { date: '2026-11-12', dateLabel: '11 月 12 日 周四', summary: { done: 2, action: 1, unverified: 3, manual: 0 }, accounts: [], platforms: [], selectablePlatforms: [], scheduleInstalled: false, runTimes: [], changes: [], unintegrated: [], job: null, ...patch };
}
function job(patch = {}) { return { kind: 'run', label: '', startedAt: 0, finishedAt: 1, exitCode: 0, reason: '故障', ...patch }; }
function activity(patch = {}) { return { kind: 'run', phase: 'running', startedAt: '2026-11-12T00:00:00Z', own: true, stopping: false, progress: null, ...patch }; }

test('纯函数覆盖状态、日期、格子与账号名字', () => {
  const f = harness().format;
  for (const s of ['claimed', 'already', 'visited']) assert.equal(f.statusTone(s), 'ok');
  for (const s of ['need-login', 'captcha', 'not-found', 'unconfirmed', 'error']) assert.equal(f.statusTone(s), 'warn');
  assert.equal(f.statusTone('other'), 'n');
  assert.deepEqual(f.todayView(null), { text: '今天还没跑', tone: 'n', time: '', detail: '' });
  assert.deepEqual(f.todayView({ status: 'claimed', statusName: '已领', time: '08:00', detail: '忽略' }), { text: '已领', tone: 'ok', time: '08:00', detail: '' });
  assert.equal(f.todayView({ status: 'error', statusName: '失败', time: '', detail: '原因' }).detail, '原因');
  assert.equal(f.todayView({ status: 'other', statusName: '其他', time: '', detail: '忽略' }).detail, '');
  assert.deepEqual(f.weekCells([{ date: '2026-11-01', status: 'claimed', statusName: '已领' }, { date: '2026-11-02', status: 'error', statusName: '失败' }, { date: '2026-11-03', status: 'other', statusName: '其他' }, { date: '2026-11-04', status: null, statusName: null }]), [{ tone: 'ok', label: '11-01 已领' }, { tone: 'warn', label: '11-02 失败' }, { tone: 'n', label: '11-03 其他' }, { tone: 'none', label: '11-04 没跑' }]);
  assert.equal(f.autoLabel(['08:30', '12:00']), '每天 08:30、12:00 自动领');
  assert.equal(f.clock('2026-11-12T00:00:00Z', '2026-11-12'), '08:00');
  assert.equal(f.clock('2026-11-11T00:00:00Z', '2026-11-12'), '11-11 08:00');
  assert.equal(f.clock('bad', '2026-11-12'), '');
  assert.equal(f.validateAccountName('  '), '名字不能空着');
  assert.equal(f.validateAccountName('长'.repeat(21)), '名字最多 20 个字');
  assert.equal(f.validateAccountName(' 名字 '), null);
});

test('状态行按优先级逐条显示', () => {
  const f = harness().format; const now = Date.parse('2026-11-12T00:00:10Z');
  const check = (s, text, kind, stop = false, retry = false, progress = null, note = '') => assert.deepEqual(f.statusLine(state(s), now, note), { kind, text, canStop: stop, canRetry: retry, progress });
  check({ activity: activity({ stopping: true }) }, '正在停止…', 'stopping');
  check({ activity: activity({ phase: 'queued' }) }, '在排队，轮到就开始。已等 10 秒。', 'queued', true);
  check({ activity: activity({ progress: { index: 2, total: 4, accountName: '主号', platformName: '平台' } }) }, '正在领取：主号 · 平台（第 2 家，共 4 家），已用 10 秒。', 'running', true, false, .5);
  check({ activity: activity() }, '正在领取，已用 10 秒。', 'running', true);
  check({ activity: activity({ kind: 'login' }), job: job({ label: '登录各家' }) }, '登录窗口已经打开。逐个标签页登录，全部登完关掉那个 Chrome 窗口。', 'login', true);
  check({ activity: activity({ kind: 'login' }), job: job({ label: '平台' }) }, '平台的登录页已经打开，登完关掉那个 Chrome 窗口。', 'login', true);
  check({ activity: activity({ kind: 'login', own: false }) }, '登录窗口开着。登完关掉那个 Chrome 窗口，或点「停止」。', 'login', true);
  check({ activity: activity({ kind: 'probe' }) }, '正在处理…', 'busy');
  check({}, '临时提示', 'note', false, false, null, '临时提示');
  check({ job: job({ stopped: true }), lastRun: { outcome: 'stopped', ran: 2, total: 5 } }, '已停止。跑了 2 家，剩下 3 家没跑。', 'stopped');
  check({ job: job({ stopped: true }) }, '已停止。', 'stopped');
  check({ job: job({ exitCode: 1 }) }, '没办成：故障', 'failed', false, true);
  check({ job: job() }, '跑完了：今天已领 2 家，要你处理 1 家，还没校准 3 家。', 'done');
  check({ job: job({ kind: 'login' }) }, '登录窗口已关。点「现在领一次」试试能不能领到。', 'done');
  check({ job: job({ kind: 'schedule-on' }) }, '已打开自动领。', 'done');
  check({ job: job({ kind: 'schedule-off' }) }, '已关掉自动领。', 'done');
  check({ job: job({ finishedAt: null }) }, '正在处理…', 'busy');
  const last = { finishedAt: '2026-11-12T00:00:00Z', ran: 2, total: 5, error: '错误' };
  check({ lastRun: { ...last, outcome: 'done' } }, '上次 08:00 跑完。', 'idle');
  check({ lastRun: { ...last, outcome: 'stopped' } }, '上次 08:00 被停止，跑了 2 家，剩下 3 家没跑。', 'idle');
  check({ lastRun: { ...last, outcome: 'failed' } }, '上次 08:00 出错：错误', 'idle');
  check({}, '', 'idle');
});

test('页面渲染各状态、提示和空态', async () => {
  const { format, render } = harness(); const now = Date.parse('2026-11-12T00:00:10Z');
  for (const [s, text, stop] of [
    [state(), '', false], [state({ activity: activity({ phase: 'queued' }) }), '在排队，轮到就开始。已等 10 秒。', true],
    [state({ activity: activity({ progress: { index: 1, total: 2, accountName: '主号', platformName: '平台' } }) }), '正在领取：主号 · 平台（第 1 家，共 2 家），已用 10 秒。', true],
    [state({ activity: activity({ stopping: true }) }), '正在停止…', false], [state({ job: job({ stopped: true }) }), '已停止。', false],
    [state({ job: job({ exitCode: 1 }) }), '没办成：故障', false], [state({ activity: activity({ kind: 'login', own: false }) }), '登录窗口开着。登完关掉那个 Chrome 窗口，或点「停止」。', true],
  ]) {
    const html = await render({ data: s, line: format.statusLine(s, now, '') });
    assert.ok(html.includes(text)); assert.equal(/>停止<\/button>/.test(html), stop);
    if (s.job?.exitCode === 1) assert.match(html, /再试一次/);
    if (s.activity?.progress) assert.match(html, /scaleX\(0\.5\)/);
  }
  let html = await render(); assert.doesNotMatch(html, /领取时只会/);
  assert.match(html, /只能在软件里领（0）/); assert.match(html, /今天的福利变动（0）/); assert.match(html, /清单上有、你还没接的（0）/); assert.match(html, /今天没有变动/); assert.match(html, /想接哪家，告诉 Claude。/);
  html = await render({ data: state({ calibration: { total: 2, pending: 2 }, accounts: [{ id: '1', name: '暂停号', enabled: false, platforms: [{ id: 'p', name: '不应出现' }] }] }) });
  assert.match(html, /有 2 家还没校准，领取时只会把它们的网页打开一遍，领不到东西。/); assert.match(html, /已暂停/); assert.doesNotMatch(html, /不应出现/);
  html = await render({ status: 'loading', data: null }); assert.match(html, /正在读取每日福利/); assert.match(html, /res-skeleton/); assert.doesNotMatch(html, /现在领一次/);
  html = await render({ status: 'error', data: null, errorLine: '读取错误' }); assert.match(html, /读不到每日福利/); assert.match(html, /读取错误/); assert.match(html, /重试/);
  html = await render({ errorLine: '网络错误' }); assert.match(html, /刷新失败：网络错误/); assert.match(html, /现在领一次/);
});

test('账号、平台、周记录和折叠内容来自状态', async () => {
  const { render } = harness();
  const platform = { id: 'demo', name: '示例平台', url: 'https://example.org', reward: '积分', mode: 'manual', today: { status: 'error', statusName: '需处理', detail: '请登录', time: '08:00' }, last7: [{ date: '2026-11-12', status: 'error', statusName: '需处理' }] };
  const html = await render({ data: state({ platforms: [platform], accounts: [{ id: 'a', name: '主号', enabled: true, platforms: [platform] }], changes: [{ kind: 'added', name: '新平台', sourceLabel: '清单', detail: '' }, { kind: 'removed', name: '旧平台', sourceLabel: '清单', detail: '' }, { kind: 'changed', name: '改动平台', sourceLabel: '清单', detail: '福利改变' }], unintegrated: [{ name: '待接平台', url: 'https://example.org', reward: '积分', cadenceLabel: '每天' }] }) });
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
  for (const value of ['主号', '领 1 家', '登录各家', '管理', '示例平台', '请登录', '08:00', '11-12 需处理', '只能在软件里领（1）', '今天的福利变动（3）', '新增：新平台（清单）', '下架：旧平台（清单）', '变动：改动平台（清单） 福利改变', '清单上有、你还没接的（1）', '待接平台']) assert.ok((value === '11-12 需处理' ? html : visible).includes(value), value);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('源码接线及接口范围', () => {
  const view = read('web/src/views/ResourceAccounts.vue');
  assert.match(view, /<header class="page-head">[\s\S]*?<h1>账号与额度<\/h1>[\s\S]*?role="tablist"[\s\S]*?账号管理[\s\S]*?每日福利[\s\S]*?<\/header>/);
  assert.match(view, /fetchPerksAvailable\(/); assert.match(view, /route\.query\.tab/); assert.match(view, /onUnmounted[\s\S]*stopPerksTimer\(\)/);
  const endpoints = [...read('web/src/api/perks.ts').matchAll(/'(\/api\/[^']*)'/g)].map(m => m[1]);
  assert.deepEqual(endpoints, ['/api/perks/available', '/api/perks', '/api/perks/action']);
});
