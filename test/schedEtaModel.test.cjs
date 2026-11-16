'use strict';
// schedEtaModel.test.cjs —— 估时模型纯函数与黄金夹具同源校验(AD-20261116-SCHED-ETA-LEARN)。
// E1 逐例把夹具输入交给对应函数,结果与 expected 深度相等;E2 源文件在时两份字节必须相同。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../core/schedEtaModel.cjs');

const ROOT = path.resolve(__dirname, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'sched', 'eta-model-golden.json');
// 派单员那份模型文件的位置由环境变量给(本仓不写死别的仓的盘符路径);没给就跳过同源校验。
const SOURCE = process.env.ETA_MODEL_SOURCE || '';
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

/** 夹具里 case.call 指向的函数;认不出来直接报错,不静默跳过。 */
function call(case_) {
  if (case_.call === 'predictRun') return model.predictRun(golden.model, case_.input);
  if (case_.call === 'predictRemaining') return model.predictRemaining(golden.model, case_.input.query, case_.input.elapsedMs);
  if (case_.call === 'predictStartMs') return model.predictStartMs(golden.model, case_.input.machine, case_.input.fallbackMs);
  throw new Error('夹具出现未知调用:' + String(case_.call));
}

test('E1 黄金夹具每个用例都与模型输出逐字段相等', () => {
  assert.ok(Array.isArray(golden.cases) && golden.cases.length >= 17, '夹具用例数不对');
  for (const case_ of golden.cases) {
    assert.deepEqual(call(case_), case_.expected, '用例不相等:' + case_.name);
  }
  // 解析夹具模型本身也必须是合法模型,否则后面的用例只是碰巧成立。
  assert.deepEqual(model.parseModel(JSON.stringify(golden.model)), { ok: true, model: golden.model });
});

test('E2 本仓模型与派单员源文件字节相同(源文件不存在时跳过)', t => {
  if (SOURCE === '' || !fs.existsSync(SOURCE)) {
    t.skip('没设环境变量 ETA_MODEL_SOURCE 或路径不存在,跳过同源字节校验(CI 机上没有派单员那份文件)');
    return;
  }
  const local = fs.readFileSync(path.join(ROOT, 'core', 'schedEtaModel.cjs'));
  const source = fs.readFileSync(SOURCE);
  assert.equal(local.length, source.length, '两份模型文件长度不同');
  assert.ok(local.equals(source), '本仓 core/schedEtaModel.cjs 必须与派单员源文件逐字节相同');
});
