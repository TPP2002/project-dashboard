'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDeepseekKey, evaluateDeepseekBalance, fetchDeepseekBalance } = require('../core/deepseekBalance.cjs');

const NOW = '2026-09-13T02:03:04.000Z';
const balanceBody = (amount = '110.00') => ({
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '999.99' },
    { currency: 'CNY', total_balance: amount, granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
});
const readKey = () => ({ ok: true, key: 'test-key' });
const now = () => NOW;

function assertUnavailable(value, reason) {
  assert.deepEqual(value, { available: false, reason: value.reason, balance: null, sampledAt: NOW });
  assert.match(value.reason, reason);
}

test('evaluateDeepseekBalance:选人民币总余额，保留数值精度，文案保留两位小数', () => {
  assert.deepEqual(evaluateDeepseekBalance(200, balanceBody(), NOW), {
    available: true, reason: 'DeepSeek 余额 ¥110.00', balance: 110, sampledAt: NOW,
  });
  assert.deepEqual(evaluateDeepseekBalance(200, balanceBody(' 110.125 '), NOW), {
    available: true, reason: 'DeepSeek 余额 ¥110.13', balance: 110.125, sampledAt: NOW,
  });
});

test('evaluateDeepseekBalance:查询成功不根据 is_available、零余额或负余额拦截', () => {
  for (const amount of [0, -0.01]) {
    const body = { ...balanceBody(amount), is_available: false };
    assert.deepEqual(evaluateDeepseekBalance(200, body, NOW), {
      available: true, reason: `DeepSeek 余额 ¥${amount.toFixed(2)}`, balance: amount, sampledAt: NOW,
    });
  }
});

test('evaluateDeepseekBalance:所有非 200 状态均不可用，不信任错误响应里的余额', () => {
  for (const status of [201, 204, 301, 401, 429, 500]) {
    assertUnavailable(evaluateDeepseekBalance(status, balanceBody(), NOW), new RegExp(`HTTP ${status}`));
  }
});

test('evaluateDeepseekBalance:返回体必须是对象', () => {
  for (const body of [null, undefined, [], 'balance', 110, false]) {
    assertUnavailable(evaluateDeepseekBalance(200, body, NOW), /响应不是对象/);
  }
});

test('evaluateDeepseekBalance:缺 CNY 条目时不可用，不把美元当人民币', () => {
  for (const body of [{}, { balance_infos: null }, { balance_infos: {} }, { balance_infos: [] },
    { balance_infos: [null, { currency: 'USD', total_balance: '100' }] }]) {
    assertUnavailable(evaluateDeepseekBalance(200, body, NOW), /缺少人民币/);
  }
});

test('evaluateDeepseekBalance:无效金额不能被转成零或截取为部分数字', () => {
  for (const amount of ['', '  ', 'invalid', '110CNY', 'Infinity', NaN, Infinity, null, true, [], {}]) {
    assertUnavailable(evaluateDeepseekBalance(200, balanceBody(amount), NOW), /不是有效数字/);
  }
  assertUnavailable(evaluateDeepseekBalance(200, { balance_infos: [{ currency: 'CNY' }] }, NOW), /不是有效数字/);
});

test('readDeepseekKey:进程环境优先且去空白，不查询注册表', () => {
  assert.deepEqual(readDeepseekKey({ env: { DEEPSEEK_API_KEY: '  process-key\n' }, platform: 'win32',
    runReg: () => assert.fail('已有进程密钥，不应读注册表') }), { ok: true, key: 'process-key' });
});

test('readDeepseekKey:Windows 缺进程密钥时只查询一次用户环境，兼容注册表类型', () => {
  for (const type of ['REG_SZ', 'REG_EXPAND_SZ']) {
    let calls = 0;
    const result = readDeepseekKey({ env: { DEEPSEEK_API_KEY: ' \n' }, platform: 'win32',
      runReg: (command, args, options) => {
        calls++;
        assert.equal(command, 'reg');
        assert.deepEqual(args, ['query', 'HKCU\\Environment', '/v', 'DEEPSEEK_API_KEY']);
        assert.equal(options.encoding, 'utf8');
        assert.equal(options.windowsHide, true);
        assert.ok(options.timeout > 0);
        return { status: 0, stdout: `HKEY_CURRENT_USER\\Environment\r\n    DEEPSEEK_API_KEY    ${type}    registry-key  \r\n` };
      } });
    assert.deepEqual(result, { ok: true, key: 'registry-key' });
    assert.equal(calls, 1);
  }
});

test('readDeepseekKey:非 Windows 不运行 reg；缺配置、查询失败与抛错均返回未配置', () => {
  assert.deepEqual(readDeepseekKey({ env: {}, platform: 'linux', runReg: () => assert.fail('不可运行 reg') }), {
    ok: false, reason: '未配置 DEEPSEEK_API_KEY',
  });
  for (const runReg of [
    () => ({ status: 1, stdout: 'DEEPSEEK_API_KEY REG_SZ stale-key' }),
    () => ({ status: 0, stdout: '未找到该值' }),
    () => ({ status: 0, stdout: 'DEEPSEEK_API_KEY REG_SZ   ' }),
    () => ({ status: null, error: new Error('reg unavailable') }),
    () => { throw new Error('reg unavailable'); },
  ]) {
    const result = readDeepseekKey({ env: {}, platform: 'win32', runReg });
    assert.equal(result.ok, false);
    assert.match(result.reason, /未配置 DEEPSEEK_API_KEY/);
    assert.equal(Object.hasOwn(result, 'key'), false);
  }
});

test('fetchDeepseekBalance:未配置时不发网络请求', async () => {
  const value = await fetchDeepseekBalance({ now,
    readKey: () => readDeepseekKey({ env: {}, platform: 'linux' }),
    fetchImpl: () => assert.fail('无密钥不得联网'),
  });
  assertUnavailable(value, /^未配置 DEEPSEEK_API_KEY$/);
});

test('fetchDeepseekBalance:每次 GET 官方接口并带 Bearer，返回当次余额与查询时间', async () => {
  let calls = 0;
  const times = [NOW, '2026-09-13T02:03:05.000Z'];
  const options = { readKey, now: () => times[calls], fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.ok(init.signal instanceof AbortSignal);
    const amount = calls++ === 0 ? '110.00' : '109.00';
    return { status: 200, json: async () => balanceBody(amount) };
  } };
  assert.deepEqual(await fetchDeepseekBalance(options), {
    available: true, reason: 'DeepSeek 余额 ¥110.00', balance: 110, sampledAt: times[0],
  });
  assert.deepEqual(await fetchDeepseekBalance(options), {
    available: true, reason: 'DeepSeek 余额 ¥109.00', balance: 109, sampledAt: times[1],
  });
  assert.equal(calls, 2);
});

test('fetchDeepseekBalance:HTTP 失败保持具体状态，即使错误页不是 JSON', async () => {
  const value = await fetchDeepseekBalance({ readKey, now, fetchImpl: async () => ({
    status: 503, json: () => assert.fail('错误页无需解析'),
  }) });
  assertUnavailable(value, /HTTP 503/);
});

test('fetchDeepseekBalance:网络、超时和 JSON 错误均返回不可用且不泄漏异常原文', async () => {
  for (const [error, reason] of [
    [new Error('private-key in transport error'), /查询异常/],
    [Object.assign(new Error('private-key timed out'), { name: 'TimeoutError' }), /查询超时/],
    [Object.assign(new Error('private-key aborted'), { name: 'AbortError' }), /查询超时/],
  ]) {
    const value = await fetchDeepseekBalance({ readKey, now, fetchImpl: async () => { throw error; } });
    assertUnavailable(value, reason);
    assert.ok(!JSON.stringify(value).includes('private-key'));
  }
  const value = await fetchDeepseekBalance({ readKey, now, fetchImpl: async () => ({
    status: 200, json: async () => { throw new SyntaxError('private-key in invalid JSON'); },
  }) });
  assertUnavailable(value, /响应无法解析/);
  assert.ok(!JSON.stringify(value).includes('private-key'));
});
