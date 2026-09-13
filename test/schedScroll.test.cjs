'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../web/package.json'));
const { parse } = webRequire('vue/compiler-sfc');
const postcss = webRequire('postcss');
const directory = path.join(__dirname, '../web/src/components/sched');
const shared = postcss.parse(fs.readFileSync(path.join(directory, 'console.css'), 'utf8'));
const REGION = ':where(.sched-page) .sched-scroll-region';
const files = ['LedgerTable.vue', 'CodexTickets.vue', 'QueueTable.vue', 'RecentCommands.vue'];

// 静态守住可滚容器与样式契约；不模拟浏览器尺寸，scrollHeight 和滚动后的表头位置由真机验收。
function component(file) {
  const filename = path.join(directory, file);
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  assert.deepEqual(errors, [], `${file} 模板必须能解析`);
  assert.ok(descriptor.template.ast, `${file} 必须有模板树`);
  return { ast: descriptor.template.ast, styles: descriptor.styles.map(block => postcss.parse(block.content)) };
}
function elements(node) {
  return (node.children || []).flatMap(child => [ ...(child.type === 1 ? [child] : []), ...elements(child) ]);
}
function attribute(node, name) {
  return node.props?.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
}
const classes = node => (attribute(node, 'class') || '').split(/\s+/).filter(Boolean);
function region(view) {
  const found = elements(view.ast).filter(node => classes(node).includes('sched-scroll-region'));
  assert.equal(found.length, 1, '每个列表组件只给自己的内容区加滚动边界');
  return found[0];
}
function declarations(sheet, selector) {
  const result = {};
  sheet.walkRules(rule => {
    if (rule.parent.type === 'root' && rule.selectors.includes(selector)) {
      rule.nodes.filter(node => node.type === 'decl').forEach(node => { result[node.prop] = node.value; });
    }
  });
  return result;
}
function declaredRegionStyle(view, node) {
  const result = declarations(shared, REGION);
  for (const style of view.styles) for (const name of classes(node)) Object.assign(result, declarations(style, `.${name}`));
  return result;
}

test('四类列表只限制内容区：视口高度上限、超出才滚动，短列表不强撑高度或预留滚动槽', () => {
  for (const file of files) {
    const view = component(file), box = region(view), style = declaredRegionStyle(view, box);
    assert.equal(box.tag, 'div');
    assert.ok(elements(box).some(node => node.tag === 'table' || node.tag === 'ul'), `${file} 列表必须在滚动框内`);
    assert.equal(elements(box).some(node => ['h2', 'h3', 'form'].includes(node.tag) || classes(node).includes('pager')), false,
      `${file} 标题与操作栏不能随列表滚走`);
    const viewportLimit = /([\d.]+)(?:d|s|l)?vh\b/.exec(style['max-height'] || '');
    assert.ok(viewportLimit && Number(viewportLimit[1]) > 0 && Number(viewportLimit[1]) <= 100, `${file} 上限须随视口变化`);
    assert.equal(style['overflow-y'], 'auto', `${file} 不得始终显示滚动条或让列表无限伸长`);
    assert.equal(style.height || 'auto', 'auto', `${file} 短列表须按内容收缩`);
    assert.equal(style['min-height'] || '0', '0');
    assert.equal(style['scrollbar-gutter'], 'auto', `${file} 不得预留空滚动槽`);
    assert.match(style.border, /solid\s+var\(/, `${file} 可滚区必须有可见边界`);
    assert.equal(attribute(box, 'tabindex'), '0', `${file} 键盘也能进入滚动区`);
    assert.equal(attribute(box, 'role'), 'region');
  }
});

test('台账表头在同一个滚动框内吸顶，并用不透明背景隔开经过的记录', () => {
  const box = region(component('LedgerTable.vue'));
  const table = elements(box).find(node => node.tag === 'table');
  assert.ok(table.children.some(node => node.tag === 'thead'));
  assert.ok(table.children.some(node => node.tag === 'tbody'));
  const header = declarations(shared, `${REGION} .sched-table thead th`);
  assert.equal(header.position, 'sticky'); assert.equal(header.top, '0');
  assert.ok(Number(header['z-index']) > 0); assert.equal(header.background, 'var(--surface-2)');
  assert.equal(declarations(shared, `${REGION} .sched-table`)['border-collapse'], 'separate');
});

test('每个施工方窗口都有自己的滚动内容区，短窗口不被邻居撑高', () => {
  const view = component('EngineTickets.vue');
  assert.equal(elements(view.ast).some(node => classes(node).includes('sched-scroll-region')), false,
    '不能把所有施工方合成一个滚动区');
  assert.ok(elements(view.ast).some(node => node.tag === 'CodexTickets' && node.props.some(prop => prop.name === 'for')));
  const grid = view.styles.map(style => declarations(style, '.engine-windows')).find(style => style.display);
  assert.equal(grid['align-items'], 'start');
  const ticketWindow = component('CodexTickets.vue'), box = region(ticketWindow);
  assert.ok(classes(box).includes('engine-body'));
  assert.equal(elements(box).some(node => node.tag === 'h3'), false);
});

test('窄屏内容在边界内换行，表格与按钮不能横向撑开滚动区', () => {
  const bounded = declarations(shared, REGION);
  assert.equal(bounded['max-width'], '100%'); assert.equal(bounded['min-width'], '0');
  assert.equal(bounded['overflow-x'], 'hidden'); assert.equal(bounded['overflow-wrap'], 'anywhere');
  assert.equal(declarations(shared, `${REGION} .sched-table`)['table-layout'], 'fixed');
  for (const child of ['.sched-table th', '.sched-table td', '.sched-tag', '.sched-link', '.sched-btn']) {
    const style = declarations(shared, `${REGION} ${child}`);
    assert.equal(style['white-space'], 'normal', `${child} 内容不可被强制挤成一行`);
    assert.equal(style['overflow-wrap'], 'anywhere', `${child} 长标识仍须完整换行展示`);
  }
});

test('主视图按按钮带、机器、排队、外派单、台账纵向排列，排队紧接机器区', () => {
  const view = component('../../views/SchedConsole.vue'), nodes = elements(view.ast);
  const primaryTags = ['ReserveCard', 'MachineCard', 'QueueTable', 'EngineTickets', 'LedgerTable'];
  const sequence = nodes.filter(node => primaryTags.includes(node.tag)).map(node => node.tag);
  assert.deepEqual(sequence.filter((tag, index) => tag !== sequence[index - 1]), primaryTags);
  const readable = nodes.find(node => node.tag === 'template' && node.children.some(child => child.tag === 'QueueTable'));
  assert.ok(readable, '主要列表须保留在可读快照的分支内');
  const blocks = readable.children.filter(node => node.type === 1);
  const queueIndex = blocks.findIndex(node => node.tag === 'QueueTable');
  assert.ok(queueIndex > 0);
  assert.ok(elements(blocks[queueIndex - 1]).some(node => node.tag === 'MachineCard'), '排队前必须紧接机器区');
  assert.deepEqual(blocks.slice(queueIndex, queueIndex + 3).map(node => node.tag), ['QueueTable', 'EngineTickets', 'LedgerTable']);
  assert.equal(blocks.length, queueIndex + 4, '台账后仅保留收起的更多区域');
  assert.ok(classes(blocks.at(-1)).includes('sched-more'));
  const page = view.styles.map(style => declarations(style, '.sched-page')).find(style => style.display);
  assert.equal(page.display, 'flex'); assert.equal(page['flex-direction'], 'column');
});

test('最近指令只出现在页底默认收起的折叠区，回执、提交记录与重试通道完整保留', () => {
  const view = component('../../views/SchedConsole.vue'), nodes = elements(view.ast);
  const commands = nodes.filter(node => node.tag === 'RecentCommands');
  assert.equal(commands.length, 1, '最近指令不能删掉，也不能在主视图重复展开');
  const fold = nodes.find(node => node.tag === 'details' && elements(node).includes(commands[0]));
  assert.ok(fold, '最近指令必须放在原生折叠区内');
  assert.equal(fold.props.some(prop => prop.name === 'open' || prop.arg?.content === 'open'), false, '默认不展开');
  const summary = fold.children.find(node => node.tag === 'summary');
  assert.ok(summary); assert.ok(nodes.indexOf(fold) > nodes.findIndex(node => node.tag === 'LedgerTable'));
  const binding = (name, arg) => commands[0].props.find(prop => prop.type === 7 && prop.name === name && prop.arg?.content === arg)?.exp?.content;
  assert.equal(binding('bind', 'receipts'), 'store.snapshot.recentReceipts');
  assert.equal(binding('bind', 'submitted'), 'store.commands');
  assert.equal(binding('on', 'retry'), 'store.retryLegacy');
  const foldStyle = view.styles.map(style => declarations(style, '.sched-more')).find(style => Object.keys(style).length);
  assert.equal(foldStyle.height || 'auto', 'auto'); assert.equal(foldStyle['min-height'] || '0', '0');
});
