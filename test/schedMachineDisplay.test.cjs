'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const modulePromise = import('../core/schedMachineDisplay.mjs');
const reading = changes => ({ online: true, availableCores: 11.9, quotaCores: 17, grantedCores: 2,
  externalLoadCores: 1.1, ci: 'idle', reservation: null, ...changes });

test('配额 17、未接入占用 14.8、可用 0 必须显示占满，差额不能被当成可派核', async () => {
  const { machineCapacity } = await modulePromise;
  const machine = Object.freeze(reading({ availableCores: 0, grantedCores: 0, externalLoadCores: 14.8, ci: 'active' }));
  const result = machineCapacity(machine, false);
  assert.equal(result.label, '已被占满'); assert.equal(result.kind, 'full');
  assert.equal(result.tone, 'warn'); assert.equal(result.barPercent, 100);
  assert.match(result.detail, /配额已用尽/); assert.match(result.detail, /波动余量/);
  assert.match(result.detail, /可用核为 0，不能再派/);
  assert.match(result.barLabel, /不代表实测利用率/);
  assert.equal(machine.availableCores, 0);
});

test('CI 空闲但可用核为零仍显示占满，说明已派任务及未接入占用', async () => {
  const { machineCapacity } = await modulePromise;
  const result = machineCapacity(reading({ availableCores: 0, grantedCores: 8, externalLoadCores: 6 }), false);
  assert.equal(result.label, '已被占满'); assert.equal(result.tone, 'warn'); assert.equal(result.barPercent, 100);
  assert.match(result.detail, /已派任务/); assert.match(result.detail, /未接入调度的占用/);
  assert.match(result.detail, /CI 空闲不代表机器可派/);
  const reservation = machineCapacity(reading({ availableCores: 0, grantedCores: 0, externalLoadCores: 0,
    reservation: { requestedCores: 15 } }), false);
  assert.match(reservation.detail, /负责人预留/); assert.equal(reservation.kind, 'full');
});

test('空闲结论直接使用可用核，不从其他数字倒算，条形按不可再派份额显示正常色', async () => {
  const { machineCapacity } = await modulePromise;
  const result = machineCapacity(reading(), false);
  assert.equal(result.label, '空闲 11.9 核可派'); assert.equal(result.kind, 'available'); assert.equal(result.tone, 'ok');
  assert.ok(Math.abs(result.barPercent - 30) < 1e-10);
  assert.match(result.detail, /能否再派看可用核/);
  const changedDetails = machineCapacity(reading({ grantedCores: 0, externalLoadCores: 0 }), false);
  assert.equal(changedDetails.label, result.label); assert.equal(changedDetails.barPercent, result.barPercent);
  const tiny = machineCapacity(reading({ availableCores: 0.001 }), false);
  assert.equal(tiny.kind, 'available'); assert.equal(tiny.label, '空闲 <0.1 核可派');
});

test('离线和过期优先于满闲数字，使用灰色条，不能把旧可用核当作空闲', async () => {
  const { machineCapacity } = await modulePromise;
  for (const availableCores of [0, 11.9]) {
    const offline = machineCapacity(reading({ online: false, availableCores }), true);
    assert.equal(offline.label, '离线'); assert.equal(offline.tone, 'muted'); assert.equal(offline.barPercent, null);
    const stale = machineCapacity(reading({ availableCores }), true);
    assert.equal(stale.label, '数据过期'); assert.equal(stale.tone, 'muted'); assert.equal(stale.barPercent, null);
    assert.match(stale.detail, /旧快照/);
  }
});

test('缺字段、无效数字和零配额安全降级，同输入结果可重放且不修改快照', async () => {
  const { machineCapacity } = await modulePromise;
  for (const machine of [null, undefined, {}, reading({ availableCores: undefined }), reading({ availableCores: null }),
    reading({ availableCores: NaN }), reading({ availableCores: Infinity }), reading({ availableCores: -1 })]) {
    let result;
    assert.doesNotThrow(() => { result = machineCapacity(machine, false); });
    assert.equal(result.kind, 'unknown'); assert.equal(result.barPercent, null);
  }
  const zero = machineCapacity(reading({ quotaCores: 0, availableCores: 0 }), false);
  assert.equal(zero.kind, 'full'); assert.equal(zero.barPercent, 100);
  assert.equal(machineCapacity(reading({ quotaCores: 0 }), false).barPercent, null);
  assert.match(machineCapacity(reading({ quotaCores: undefined, availableCores: 0 }), false).barLabel, /配额未知/);
  assert.equal(machineCapacity(reading({ availableCores: 20 }), false).barPercent, 0);
  const machine = Object.freeze(reading());
  const before = JSON.stringify(machine);
  assert.deepEqual(machineCapacity(machine, false), machineCapacity(machine, false));
  assert.equal(JSON.stringify(machine), before);
});

test('可用核 3.9000000000000004 显示成 3.9，原值不被改动', async () => {
  const { machineCapacity, formatCores } = await modulePromise;
  const machine = Object.freeze(reading({ availableCores: 3.9000000000000004, quotaCores: 17.000000000000004 }));
  const result = machineCapacity(machine, false);
  assert.equal(result.label, '空闲 3.9 核可派');
  assert.match(result.detail, /这 3\.9 核/); assert.match(result.barLabel, /可用 3\.9 核 \/ 配额 17 核/);
  assert.doesNotMatch(result.label + result.detail + result.barLabel, /3\.9000/);
  assert.equal(formatCores(2), '2'); assert.equal(formatCores(0.1 + 0.2), '0.3');
  assert.equal(machine.availableCores, 3.9000000000000004);
  assert.equal(formatCores(3.96, { floor: true }), '3.9'); assert.equal(formatCores(3.96), '4');
  assert.equal(machineCapacity(reading({ availableCores: 3.96 }), false).label, '空闲 3.9 核可派');
  assert.equal(formatCores(0.09999999999999998), '<0.1'); assert.equal(formatCores(3.8999999999999995, { floor: true }), '3.9');
});

test('作业槽只呈现实测读数:正常、空槽、满槽、超占与未知分别说明,未知不冒充空闲,离线过期注明旧快照', async () => {
  const { agentSlotsDisplay } = await modulePromise;
  const normal = agentSlotsDisplay({ capacity: 4, occupied: 2 });
  assert.equal(normal.known, true); assert.equal(normal.full, false); assert.equal(normal.tone, 'ok');
  assert.equal(normal.numbers, '2 / 4');
  assert.match(normal.detail, /占用 2、容量 4/); assert.match(normal.detail, /有空闲核也可能在等作业槽/);
  const empty = agentSlotsDisplay({ capacity: 4, occupied: 0 });
  assert.equal(empty.known, true); assert.equal(empty.full, false); assert.equal(empty.numbers, '0 / 4');
  const full = agentSlotsDisplay({ capacity: 4, occupied: 4 });
  assert.equal(full.full, true); assert.equal(full.tone, 'warn'); assert.equal(full.numbers, '4 / 4');
  assert.match(full.detail, /执行端作业槽已满/); assert.match(full.detail, /自行改善/);
  assert.match(full.detail, /本机命令/); assert.match(full.detail, /仍可能照常派/);
  const over = agentSlotsDisplay({ capacity: 4, occupied: 6 });
  assert.equal(over.full, true); assert.equal(over.numbers, '6 / 4');
  assert.match(over.detail, /超占/); assert.match(over.detail, /占用 6、容量 4/);
  for (const unknown of [undefined, null, {}, { capacity: 4 }, { occupied: 1 }, { capacity: 0, occupied: 0 },
    { capacity: -1, occupied: 0 }, { capacity: 1.5, occupied: 0 }, { capacity: 4, occupied: -1 },
    { capacity: 4, occupied: 2.5 }, { capacity: '4', occupied: 2 }]) {
    const result = agentSlotsDisplay(unknown);
    assert.equal(result.known, false); assert.equal(result.full, false);
    assert.equal(result.numbers, '未知'); assert.match(result.detail, /未知/);
  }
  assert.match(agentSlotsDisplay({ capacity: 4, occupied: 2 }, true).detail, /旧快照/);
  assert.match(agentSlotsDisplay(null, true).detail, /旧快照/);
});

// 内存中编译实际 MachineCard 与依赖,验证卡片真的把作业槽占用/容量显示出来(夹具同 schedCiJobsWeb)。
async function machineCardHtml(machine) {
  const fs = require('node:fs');
  const webRequire = require('node:module').createRequire(path.join(__dirname, '../web/package.json'));
  const { parse, compileScript, compileTemplate } = webRequire('vue/compiler-sfc');
  const ts = webRequire('typescript'), { createSSRApp, h } = webRequire('vue');
  const { renderToString } = webRequire('vue/server-renderer');
  const directory = path.join(__dirname, '../web/src/components/sched');
  function evaluate(source, requireFn = webRequire) {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const output = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(requireFn, output, output.exports);
    return output.exports;
  }
  function compile(name, dependencies) {
    const filename = path.join(directory, name);
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
    assert.deepEqual(errors, [], `${name} 模板必须能解析`);
    const script = compileScript(descriptor, { id: name });
    const template = compileTemplate({ id: name, filename, source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    const resolve = id => Object.hasOwn(dependencies, id) ? dependencies[id] : webRequire(id);
    const component = evaluate(script.content, resolve).default;
    component.render = evaluate(template.code, resolve).render;
    return component;
  }
  const format = evaluate(fs.readFileSync(path.join(directory, 'format.ts'), 'utf8'));
  const EstimateText = compile('EstimateText.vue', { './format': format });
  const display = evaluate(fs.readFileSync(path.join(__dirname, '../core/schedMachineDisplay.mjs'), 'utf8'));
  const MachineCard = compile('MachineCard.vue', { './format': format, './EstimateText.vue': { default: EstimateText },
    '@/api/schedCiJobs': evaluate(fs.readFileSync(path.join(__dirname, '../web/src/api/schedCiJobs.ts'), 'utf8')),
    '../../../../core/schedMachineDisplay.mjs': display });
  const now = Date.parse('2026-09-14T10:00:00Z');
  const html = await renderToString(createSSRApp({ render: () => h(MachineCard, {
    machine: { name: 'machine-a', online: true, fresh: true, ci: 'idle', ciRunners: null,
      heartbeatAt: new Date(now).toISOString(), loadSampledAt: new Date(now).toISOString(),
      quotaCores: 4, grantedCores: 0, externalLoadCores: 0, availableCores: 4, ...machine },
    host: 'machine-a', tickets: [], estimates: {}, now, busy: false }) }));
  return { html, visible: html.replace(/<[^>]*>/g, '') };
}

test('机器卡实际显示作业槽占用/容量:核数与槽数分别说明,满槽不冒充核满,未知清晰可见,离线过期注明旧快照', async () => {
  const normal = await machineCardHtml({ agentSlots: { capacity: 4, occupied: 2 } });
  assert.match(normal.visible, /作业槽 2 \/ 4/);
  assert.match(normal.visible, /执行端作业槽占用 2、容量 4/);
  // 满槽且核够:核数结论保持空闲,槽数单独说明已满。
  const full = await machineCardHtml({ agentSlots: { capacity: 4, occupied: 4 } });
  assert.match(full.visible, /作业槽 4 \/ 4/); assert.match(full.visible, /空闲 4 核可派/);
  assert.match(full.visible, /执行端作业槽已满/); assert.match(full.visible, /仍可能照常派/);
  const unknown = await machineCardHtml({});
  assert.match(unknown.visible, /作业槽 未知/);
  // 离线/过期沿用现行无效态,槽满不把结论改成核满,数字注明旧快照。
  const offline = await machineCardHtml({ online: false, agentSlots: { capacity: 4, occupied: 4 } });
  assert.match(offline.visible, /离线/); assert.doesNotMatch(offline.visible, /已被占满/);
  assert.match(offline.visible, /执行端作业槽已满/); assert.match(offline.visible, /旧快照/);
  const stale = await machineCardHtml({ fresh: false, heartbeatAt: '2026-09-14T09:59:00Z',
    loadSampledAt: '2026-09-14T09:59:00Z', agentSlots: { capacity: 4, occupied: 4 } });
  assert.match(stale.visible, /数据过期/); assert.doesNotMatch(stale.visible, /已被占满/);
  assert.match(stale.visible, /旧快照/);
});
