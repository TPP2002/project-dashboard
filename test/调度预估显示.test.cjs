'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../web/package.json'));
const { parse, compileScript } = webRequire('vue/compiler-sfc');
const ts = webRequire('typescript');
const { createSSRApp, h } = webRequire('vue');
const { renderToString } = webRequire('vue/server-renderer');

// 在内存中编译实际组件和格式化模块，不生成文件，也不替换被测展示逻辑。
function evaluate(source, requireFn) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const output = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(requireFn, output, output.exports);
  return output.exports;
}
const directory = path.join(__dirname, '../web/src/components/sched');
const format = evaluate(fs.readFileSync(path.join(directory, 'format.ts'), 'utf8'), webRequire);
const filename = path.join(directory, 'EstimateText.vue');
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
assert.deepEqual(errors, []);
const script = compileScript(descriptor, { id: 'sched-estimate', inlineTemplate: true });
const EstimateText = evaluate(script.content, id => id === './format' ? format : webRequire(id)).default;
async function render(estimate) {
  const html = await renderToString(createSSRApp({ render: () => h(EstimateText, { estimate }) }));
  return { html, visible: html.replace(/<[^>]*>/g, '') };
}
const sample = { sampleCount: 3, medianMs: 10000 };

test('排队可见文字同时给等待、开跑时刻、预计耗时和 CI 预留；零核也不丢', async () => {
  for (const ciHeadroom of [0, 8]) {
    const { visible } = await render({ kind: 'wait', ...sample, waitMs: 6000, startAt: '2026-09-12T01:00:06.000Z', machine: 'fixture-worker', ciHeadroom });
    assert.match(visible, /预计等待 6 秒/); assert.match(visible, /开跑/); assert.match(visible, /预计跑 10 秒/);
    assert.ok(visible.includes(`CI 留了 ${ciHeadroom} 核`));
    assert.doesNotMatch(visible, /算不出/);
  }
});

test('低优先级执行显示调整后的耗时，历史中位耗时仍如实显示在说明中', async () => {
  const { html, visible } = await render({ kind: 'completion', ...sample, remainingMs: 11000, finishAt: '2026-09-12T01:00:11.000Z', overdue: false, slowdown: 1.5, ciHeadroom: 8 });
  assert.match(visible, /预计完成/); assert.match(visible, /预计跑 15 秒/);
  assert.match(visible, /低优先级按 1.5 倍耗时估算/); assert.match(visible, /CI 留了 8 核/);
  assert.match(html, /同类最近 3 次执行的中位耗时：10 秒/);
});

test('未知结果与缺失数据都明确写算不出及原因', async () => {
  assert.equal((await render()).visible, '算不出（读不到预估数据）');
  const { visible } = await render({ kind: 'unavailable', code: 'ci', reason: '被 CI 冻住，恢复时刻未知' });
  assert.equal(visible, '算不出（被 CI 冻住，恢复时刻未知）');
  assert.doesNotMatch(visible, /预计等待|预计完成|预计跑/);
});

test('旧估值没有可选字段仍能显示，超时不再误称平均耗时', async () => {
  const { visible } = await render({ kind: 'completion', ...sample, remainingMs: 0, finishAt: '2026-09-12T00:59:59.000Z', overdue: true });
  assert.match(visible, /已超出预计耗时/); assert.match(visible, /预计跑 10 秒/);
  assert.doesNotMatch(visible, /低优先级|CI 留了|平均耗时|算不出/);
});
