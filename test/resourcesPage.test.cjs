'use strict';
/**
 * 账号与额度页的前端测试：纯函数直接跑；组件用内存编译 + renderToString 渲染。
 * 不联网、不发请求；夹具只用占位路径与固定 JSON。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// —— 内存编译：把 .ts 与 .vue 变成可渲染组件 ——
function renderer() {
  const webRequire = require('node:module').createRequire(path.join(ROOT, 'web/package.json'));
  const { parse, compileScript, compileTemplate } = webRequire('vue/compiler-sfc');
  const ts = webRequire('typescript');
  const { createSSRApp, h } = webRequire('vue');
  const { renderToString } = webRequire('vue/server-renderer');

  function evaluate(source, requireFn = webRequire) {
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const output = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(requireFn, output, output.exports);
    return output.exports;
  }

  const format = evaluate(readSource('web/src/utils/resourcesFormat.ts'));

  function compile(rel, dependencies) {
    const filename = path.join(ROOT, rel);
    const id = path.basename(rel);
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id });
    const template = compileTemplate({
      id, filename, source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings },
    });
    assert.deepEqual(template.errors, []);
    const resolve = (id) => (Object.hasOwn(dependencies, id) ? dependencies[id] : webRequire(id));
    const component = evaluate(script.content, resolve).default;
    component.render = evaluate(template.code, resolve).render;
    return component;
  }

  const Panel = compile('web/src/components/resources/ResourcePanel.vue', { '@/utils/resourcesFormat': format });

  async function render(props) {
    const html = await renderToString(createSSRApp({ render: () => h(Panel, props) }));
    return { html, visible: html.replace(/<[^>]*>/g, '') };
  }
  return { render, format };
}

// —— 固定夹具：六个平台，覆盖各种数据状态 ——
function snapshot() {
  const readAt = '2026-11-10T02:00:00.000Z';
  const account = (patch) => ({
    id: 'qoder-1', provider: 'qoder', providerName: 'Qoder', label: '主号', enabled: true,
    login: { status: 'ok', checkedAt: '2026-11-10T01:00:00.000Z', reason: null },
    quota: null, limits: [], lastUsedAt: null, running: 0, ...patch,
  });
  return {
    formatVersion: 1,
    generatedAt: '2026-11-10T02:00:00.000Z',
    accounts: [
      account({ id: 'workbuddy-1', provider: 'workbuddy', providerName: 'WorkBuddy', label: '主力', running: 2, lastUsedAt: '2026-11-10T01:30:00.000Z' }),
      account({ id: 'workbuddy-2', provider: 'workbuddy', providerName: 'WorkBuddy', label: '备用', enabled: false,
        login: { status: 'unknown', checkedAt: null, reason: null }, running: null, lastUsedAt: null,
        quota: { remaining: 1200.5, unit: '次', usedPercent: null, resetAt: '2026-11-11T00:00:00.000Z', readAt, source: 'api' } }),
      account({ id: 'qoder-1', provider: 'qoder', providerName: 'Qoder', label: '主号', running: 1,
        lastUsedAt: '2026-11-10T02:00:00.000Z',
        login: { status: 'broken', checkedAt: '2026-11-10T01:00:00.000Z', reason: '登录过期' },
        quota: { remaining: null, usedPercent: 37, unit: '%', resetAt: null, readAt, source: 'api' },
        limits: [
          { model: '*', until: '2026-11-10T05:00:00.000Z', kind: 'rate-limit', source: 'placeholder', reason: '额度不足' },
          { model: 'qwen3-max', until: '2026-11-10T04:00:00.000Z', kind: 'quota-exhausted', source: 'platform', reason: '' },
        ] }),
      account({ id: 'trae-1', provider: 'trae', providerName: 'Trae', label: '试用',
        quota: { remaining: 300, unit: '次', usedPercent: 12, resetAt: null, readAt, source: 'estimate' } }),
      account({ id: 'codex-1', provider: 'codex', providerName: 'Codex', label: '直连', running: null }),
      account({ id: 'deepseek-1', provider: 'deepseek', providerName: 'DeepSeek', label: '深索',
        login: { status: 'unknown', checkedAt: null, reason: null } }),
      account({ id: 'claude-1', provider: 'claude', providerName: 'Claude', label: '克劳德' }),
    ],
    providers: [
      { provider: 'workbuddy', providerName: 'WorkBuddy', accountCount: 2, enabledCount: 1, gate: { open: true, reason: null, reopensAt: null } },
      { provider: 'qoder', providerName: 'Qoder', accountCount: 1, enabledCount: 1,
        gate: { open: false, reason: '额度不足', reopensAt: '2026-11-10T06:00:00.000Z' } },
      { provider: 'trae', providerName: 'Trae', accountCount: 1, enabledCount: 1, gate: { open: true, reason: null, reopensAt: null } },
      { provider: 'codex', providerName: 'Codex', accountCount: 1, enabledCount: 1, gate: { open: null, reason: '心跳没上来', reopensAt: null } },
      { provider: 'deepseek', providerName: 'DeepSeek', accountCount: 1, enabledCount: 1, gate: { open: true, reason: null, reopensAt: null } },
      { provider: 'claude', providerName: 'Claude', accountCount: 1, enabledCount: 1, gate: { open: true, reason: null, reopensAt: null } },
    ],
    ladders: {
      light: [{ provider: 'workbuddy', model: 'wb-light' }, { provider: 'qoder', model: 'qwen3' }],
      standard: [{ provider: 'workbuddy', model: 'wb-light' }, { provider: 'qoder', model: 'qwen3' }],
      hard: [{ provider: 'workbuddy', model: 'wb-light' }, { provider: 'qoder', model: 'qwen3' }],
    },
  };
}

function emptySnapshot() {
  const base = snapshot();
  return {
    ...base,
    accounts: [],
    providers: base.providers.map((p) => ({ ...p, accountCount: 0, enabledCount: 0 })),
  };
}

// —— (a) 纯函数 ——
test('北京时间：UTC 加 8 小时、跨日、带 +08:00 的原样、无效输入 null', () => {
  const { format } = renderer();
  assert.equal(format.beijingDateTime('2026-11-10T00:00:00.000Z'), '11-10 08:00');
  assert.equal(format.beijingClock('2026-11-10T00:00:00.000Z'), '08:00');
  assert.equal(format.beijingDateTime('2026-11-10T20:30:00.000Z'), '11-11 04:30');
  assert.equal(format.beijingDateTime('2026-11-10T08:00:00+08:00'), '11-10 08:00');
  for (const bad of ['', 'not-a-date', null, undefined, 0]) {
    assert.equal(format.beijingDateTime(bad), null);
    assert.equal(format.beijingClock(bad), null);
  }
});

test('额度五种：只剩余量、只已用、两者都有、估算标记、读不到', () => {
  const { format } = renderer();
  const remaining = format.quotaView({ remaining: 1200.5, unit: '次', usedPercent: null, resetAt: '2026-11-11T00:00:00.000Z', source: 'api' });
  assert.equal(remaining.kind, 'remaining');
  assert.equal(remaining.text, '剩余 1,200.5 次');
  assert.equal(remaining.resetText, '重置 11-11 08:00');
  assert.equal(remaining.estimate, false);

  const used = format.quotaView({ remaining: null, usedPercent: 37, unit: '%', resetAt: null, source: 'api' });
  assert.equal(used.kind, 'used');
  assert.equal(used.text, '已用 37%');
  assert.equal(used.resetText, null);

  const both = format.quotaView({ remaining: 300, usedPercent: 12, unit: '次', resetAt: null, source: 'api' });
  assert.equal(both.kind, 'both');
  assert.equal(both.text, '剩余 300 次 · 已用 12%');

  const estimate = format.quotaView({ remaining: 300, usedPercent: 12, unit: '次', resetAt: null, source: 'estimate' });
  assert.equal(estimate.estimate, true);

  for (const unknown of [null, undefined, { source: 'unknown', remaining: 5, usedPercent: 5, unit: '次' },
    { remaining: null, usedPercent: null, unit: '次', source: 'api' }]) {
    const view = format.quotaView(unknown);
    assert.equal(view.kind, 'unknown');
    assert.equal(view.text, '读不到');
    assert.equal(view.resetText, null);
  }
});

test('限流文案：整号、四种 kind、placeholder 加估计', () => {
  const { format } = renderer();
  const views = format.limitViews([
    { model: '*', until: '2026-11-10T05:00:00.000Z', kind: 'rate-limit', source: 'placeholder' },
    { model: 'qwen3-max', until: '2026-11-10T04:00:00.000Z', kind: 'quota-exhausted', source: 'platform' },
    { model: 'qwen3', until: '2026-11-10T04:00:00.000Z', kind: 'login-required', source: 'platform' },
    { model: 'qwen3', until: '2026-11-10T04:00:00.000Z', kind: 'other', source: 'platform' },
  ]);
  assert.deepEqual(views, [
    '整号限流至 11-10 13:00(估计)',
    'qwen3-max额度用完至 11-10 12:00',
    'qwen3需要登录至 11-10 12:00',
    'qwen3受限至 11-10 12:00',
  ]);
  assert.deepEqual(format.limitViews([]), []);
  assert.deepEqual(format.limitViews(null), []);
});

test('登录三态与未核对；只在非正常时带原因', () => {
  const { format } = renderer();
  const ok = format.loginView({ status: 'ok', checkedAt: '2026-11-10T01:00:00.000Z', reason: '不该显示' });
  assert.equal(ok.badge, '登录 正常');
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.check, '核对 11-10 09:00');
  assert.equal(ok.reason, '');

  const broken = format.loginView({ status: 'broken', checkedAt: null, reason: '登录过期' });
  assert.equal(broken.badge, '登录 失效');
  assert.equal(broken.tone, 'bad');
  assert.equal(broken.check, '未核对');
  assert.equal(broken.reason, '登录过期');

  const unknown = format.loginView({ status: 'unknown', checkedAt: null, reason: null });
  assert.equal(unknown.badge, '登录 未知');
  assert.equal(unknown.tone, 'n');
  assert.equal(unknown.check, '未核对');

  assert.equal(format.loginView(null).badge, '登录 未知');
});

test('闸三态：可派单、暂停派单带原因与恢复时刻、读不到', () => {
  const { format } = renderer();
  assert.deepEqual(format.gateView({ open: true, reason: null }), { text: '可派单', tone: 'ok' });
  assert.deepEqual(
    format.gateView({ open: false, reason: '额度不足', reopensAt: '2026-11-10T06:00:00.000Z' }),
    { text: '暂停派单:额度不足,11-10 14:00 恢复', tone: 'warn' },
  );
  assert.deepEqual(format.gateView({ open: null, reason: '心跳没上来' }), { text: '派单状态读不到:心跳没上来', tone: 'n' });
  assert.deepEqual(format.gateView(null), { text: '派单状态读不到', tone: 'n' });
});

test('派单顺序：三档相同合并，不同则各一档', () => {
  const { format } = renderer();
  const names = { workbuddy: 'WorkBuddy', qoder: 'Qoder' };
  const same = format.ladderGroups({
    light: [{ provider: 'workbuddy', model: 'wb-light' }],
    standard: [{ provider: 'workbuddy', model: 'wb-light' }],
    hard: [{ provider: 'workbuddy', model: 'wb-light' }],
  }, names);
  assert.deepEqual(same, [{ title: '轻档 / 标准档 / 难档(相同)', rows: ['第 1 格 WorkBuddy · wb-light'] }]);

  const differ = format.ladderGroups({
    light: [{ provider: 'workbuddy', model: 'wb-light' }],
    standard: [{ provider: 'qoder', model: 'qwen3' }],
    hard: [{ provider: 'qoder', model: 'qwen3' }],
  }, names);
  assert.deepEqual(differ.map((g) => g.title), ['轻档', '标准档', '难档']);
  assert.deepEqual(differ[1].rows, ['第 1 格 Qoder · qwen3']);
});

test('名字与密钥路径校验：与服务端同一组用例', () => {
  const { format } = renderer();
  assert.equal(format.validateLabel(''), null);
  assert.equal(format.validateLabel(undefined), null);
  assert.equal(format.validateLabel(' 主号 '), null);
  assert.equal(format.validateLabel('x'.repeat(20)), null);
  assert.equal(format.validateLabel('x'.repeat(21)), '名字最多 20 个字,不能换行,不能以 - 开头');
  assert.equal(format.validateLabel('a\nb'), '名字最多 20 个字,不能换行,不能以 - 开头');
  assert.equal(format.validateLabel('-abc'), '名字最多 20 个字,不能换行,不能以 - 开头');
  assert.equal(format.validateLabel(' '), '名字最多 20 个字,不能换行,不能以 - 开头');

  assert.equal(format.validateKeyFile('C:/path/to/key.txt'), null);
  assert.equal(format.validateKeyFile('/home/demo/key.txt'), null);
  assert.equal(format.validateKeyFile('C:\\path\\to\\key.txt'), null);
  assert.equal(format.validateKeyFile(''), '请填密钥文件路径');
  assert.equal(format.validateKeyFile('keys/x.txt'), '请填完整路径(盘符开头或 / 开头),不要带引号');
  assert.equal(format.validateKeyFile("C:/path/to/o'brien.txt"), '请填完整路径(盘符开头或 / 开头),不要带引号');
  assert.equal(format.validateKeyFile('C:/path/to/../secret.txt'), '请填完整路径(盘符开头或 / 开头),不要带引号');

  assert.equal(format.isKeyProvider('deepseek'), true);
  assert.equal(format.isKeyProvider('claude'), true);
  assert.equal(format.isKeyProvider('qoder'), false);
});

// —— (b) 渲染真实组件 — 分组、额度、限流、闸、派单顺序 ——
test('渲染：分组顺序、启用计数、闸文案、额度与限流、行尾按钮', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'ready', data: snapshot(), errorLine: '', refreshing: false, rowState: {}, groupState: {},
  });

  const order = [...html.matchAll(/data-provider="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['workbuddy', 'qoder', 'trae', 'codex', 'deepseek', 'claude']);

  assert.match(visible, /启用 1 \/ 共 2/);
  assert.match(visible, /可派单/);
  assert.match(visible, /暂停派单:额度不足,11-10 14:00 恢复/);
  assert.match(visible, /派单状态读不到:心跳没上来/);

  assert.match(visible, /剩余 1,200.5 次/);
  assert.match(visible, /重置 11-11 08:00/);
  assert.match(visible, /已用 37%/);
  assert.match(visible, /剩余 300 次 · 已用 12%/);
  assert.match(visible, /估算/);

  assert.match(visible, /整号限流至 11-10 13:00\(估计\)/);
  assert.match(visible, /qwen3-max额度用完至 11-10 12:00/);
  assert.match(visible, /在跑 2 单/);
  assert.match(visible, /在跑 读不到/);
  assert.match(visible, /最近使用 从未/);
  assert.match(visible, /最近使用 11-10 10:00/);
  assert.match(visible, /登录 失效/);
  assert.match(visible, /登录过期/);

  // 解除限流只在有限流的行出现
  const clearButtons = (html.match(/解除限流/g) || []).length;
  assert.equal(clearButtons, 1);
  const qoderRow = html.slice(html.indexOf('data-account="qoder-1"'));
  assert.match(qoderRow.slice(0, qoderRow.indexOf('data-account="trae-1"')), /解除限流/);

  // 停用行弱化
  assert.match(html, /class="res-row res-off" data-account="workbuddy-2"/);

  // 每组都有添加账号
  assert.equal((html.match(/添加账号/g) || []).length, 6);

  // 派单顺序默认折叠，只有一块
  assert.match(html, /<details class="res-ladders">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
  assert.match(visible, /从第 1 格往下找,前一格没有可用账号就用下一格。/);
  assert.match(visible, /轻档 \/ 标准档 \/ 难档\(相同\)/);
  assert.match(visible, /第 1 格 WorkBuddy · wb-light/);
  assert.equal((visible.match(/轻档 \/ 标准档 \/ 难档\(相同\)/g) || []).length, 1);

  // 测试钩子类名齐全
  for (const cls of ['res-group', 'res-row', 'res-quota', 'res-limits', 'res-login', 'res-actions', 'res-ladders']) {
    assert.match(html, new RegExp(`class="[^"]*${cls}`), cls);
  }
});

// —— (c) 数据状态 ——
test('状态：加载中只有骨架与视觉隐藏文字', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'loading', data: null, errorLine: '', refreshing: false, rowState: {}, groupState: {},
  });
  assert.match(html, /class="skel/);
  assert.match(visible, /正在读取账号/);
  assert.doesNotMatch(html, /data-provider=/);
});

test('状态：首次读取失败显示标题、原文与重试', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'error', data: null, errorLine: '请求来源不是本机', refreshing: false, rowState: {}, groupState: {},
  });
  assert.match(visible, /读取失败/);
  assert.match(visible, /请求来源不是本机/);
  assert.match(visible, /重试/);
  assert.match(html, /class="res-error/);
});

test('状态：已有旧数据时刷新失败只加顶部条，分组仍在', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'ready', data: snapshot(), errorLine: '派单器命令超时', refreshing: false, rowState: {}, groupState: {},
  });
  assert.match(visible, /刷新失败:/);
  assert.match(visible, /派单器命令超时/);
  assert.match(html, /data-provider="workbuddy"/);
});

test('状态：没有账号时给空态，六个分组照常显示', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'ready', data: emptySnapshot(), errorLine: '', refreshing: false, rowState: {}, groupState: {},
  });
  assert.match(visible, /还没有登记任何账号/);
  assert.match(visible, /点下面各平台的「添加账号」,登记第一个号。/);
  assert.match(html, /class="res-empty/);
  assert.equal((html.match(/data-provider=/g) || []).length, 6);
  assert.equal((visible.match(/这个平台还没有账号/g) || []).length, 6);
});

// —— (d) 操作状态 ——
test('操作状态：行内进行中、失败重试、授权页提示', async () => {
  const { render } = renderer();
  const rowState = {
    'qoder-1': { busy: 'refresh', line: '', error: false, notice: false },
    'trae-1': { busy: null, line: '命令说不行', error: true, notice: false },
    'claude-1': { busy: null, line: '打开授权页: https://example.org/authorize', error: false, notice: true },
  };
  const { html, visible } = await render({
    status: 'ready', data: snapshot(), errorLine: '', refreshing: false, rowState, groupState: {},
  });

  const qoderRow = html.slice(html.indexOf('data-account="qoder-1"'));
  const qoderBlock = qoderRow.slice(0, qoderRow.indexOf('data-account="trae-1"'));
  assert.match(qoderBlock, /刷新中…/);
  assert.match(qoderBlock, /disabled/);

  assert.match(visible, /命令说不行/);
  assert.match(visible, /重试/);
  assert.match(visible, /已打开授权页,在浏览器里点授权后点刷新/);
  assert.match(visible, /打开授权页: https:\/\/example\.org\/authorize/);
});

test('操作状态：登录中、分组添加中与分组失败、顶栏刷新中', async () => {
  const { render } = renderer();
  const { html, visible } = await render({
    status: 'ready', data: snapshot(), errorLine: '', refreshing: true,
    rowState: { 'qoder-1': { busy: 'login', line: '', error: false, notice: false } },
    groupState: {
      workbuddy: { busy: true, line: '', error: false, notice: false },
      trae: { busy: false, line: '添加失败', error: true, notice: false },
    },
  });
  assert.match(visible, /登录中…/);
  assert.match(visible, /添加中…/);
  assert.match(visible, /添加失败/);
  assert.match(visible, /刷新中…/);
  assert.match(html, /class="res-notice/);
});

// —— (e) 源码接线 ——
function read(rel) { return readSource(rel); }

test('路由与侧栏接线', () => {
  const router = read('web/src/router/index.ts');
  assert.match(router, /path: '\/resources'/);
  assert.match(router, /name: 'resources'/);
  assert.match(router, /title: '账号与额度'/);
  assert.match(router, /@\/views\/ResourceAccounts\.vue/);
  assert.doesNotMatch(router, /path: '\/resources'[^\n]*module:/);

  const nav = read('web/src/components/SideNav.vue');
  assert.match(nav, /resources: \{ to: '\/resources', icon: 'plug', title: '账号与额度' \}/);
  const projects = nav.slice(nav.indexOf("id: 'projects'"), nav.indexOf("id: 'extensions'"));
  assert.match(projects, /\{ id: 'resources', visible: true \}/);
  const extensions = nav.slice(nav.indexOf("id: 'extensions'"), nav.indexOf("id: 'analysis'"));
  assert.doesNotMatch(extensions, /resources/);
});

test('视图轮询与清理、接口只打一个端点、组件不存账号数据', () => {
  const view = read('web/src/views/ResourceAccounts.vue');
  assert.match(view, /60_000/);
  assert.match(view, /visibilityState === 'visible'/);
  assert.match(view, /onUnmounted/);
  assert.match(view, /clearInterval/);
  assert.match(view, /removeEventListener\('visibilitychange'/);

  const api = read('web/src/api/resources.ts');
  const endpoints = [...api.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(endpoints, ['/api/resources', '/api/resources/action']);
  assert.match(api, /authFetch/);

  for (const rel of [
    'web/src/views/ResourceAccounts.vue',
    'web/src/components/resources/ResourcePanel.vue',
    'web/src/components/resources/ResourceDialog.vue',
  ]) {
    const source = read(rel);
    assert.doesNotMatch(source, /localStorage/, rel);
    // 浏览器代码里不许出现 Node 的文件系统调用（样式变量 --fs-* 不算）。
    assert.doesNotMatch(source, /require\('(?:node:)?fs'\)|from '(?:node:)?fs'|readFileSync/, rel);
  }

  const panel = read('web/src/components/resources/ResourcePanel.vue');
  assert.doesNotMatch(panel, /Teleport/);
  assert.doesNotMatch(panel, /from '@\/components\/Icon\.vue'/);
});

// —— (f) 文案与界面文字一致（逐条可见文字） ——
test('弹窗与页面文案逐条对齐施工单', () => {
  const view = read('web/src/views/ResourceAccounts.vue');
  for (const line of [
    '账号与额度', '添加账号', '平台', '名字', '不填则按序号命名', '密钥文件路径', '文件的完整路径',
    '密钥由你自己放进文件,看板不读文件内容', '添加后会自动打开授权页,在浏览器里点授权。',
    '添加', '取消', '移除账号', '确认移除',
    '只从登记里拿掉,账号目录和登录凭据留在原处,不删。',
    '解除限流', '只清掉派单器里的限流标记,不会恢复平台那边的额度。', '全部限流', '解除',
  ]) {
    assert.ok(view.includes(line), `缺少文案:${line}`);
  }
  assert.match(view, /确定移除 \{\{ removeTarget\.label \}\}\(\{\{ removeTarget\.id \}\}\)\?/);

  const panel = read('web/src/components/resources/ResourcePanel.vue');
  for (const line of [
    '刷新', '刷新中…', '上次读取:北京时间', '上次读取:读不到', '正在读取账号', '读取失败',
    '刷新失败:', '还没有登记任何账号', '点下面各平台的「添加账号」,登记第一个号。',
    '添加账号', '这个平台还没有账号', '启用', '在跑 读不到', '最近使用 从未',
    '重新登录', '登录中…', '解除限流', '处理中…', '移除', '移除中…',
    '已打开授权页,在浏览器里点授权后点刷新', '派单顺序',
    '从第 1 格往下找,前一格没有可用账号就用下一格。',
  ]) {
    assert.ok(panel.includes(line), `缺少文案:${line}`);
  }
});
