'use strict';
const childProcess = require('node:child_process');

const unavailable = (reason, sampledAt) => ({ available: false, reason, balance: null, sampledAt });

/** 优先读取进程环境；Windows 再只读查询用户环境。缺配置或读取失败均返回结果，不抛异常。 */
function readDeepseekKey({ env = process.env, platform = process.platform, runReg = childProcess.spawnSync } = {}) {
  const key = typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (key) return { ok: true, key };
  if (platform === 'win32') {
    try {
      const result = runReg('reg', ['query', 'HKCU\\Environment', '/v', 'DEEPSEEK_API_KEY'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000,
      });
      if (!result.error && result.status === 0 && typeof result.stdout === 'string') {
        const registryKey = result.stdout.match(/DEEPSEEK_API_KEY\s+REG_\w+\s+(.+)/)?.[1].trim();
        if (registryKey) return { ok: true, key: registryKey };
      }
    } catch (_) {
      return { ok: false, reason: '未配置 DEEPSEEK_API_KEY（Windows 用户环境读取失败）' };
    }
  }
  return { ok: false, reason: '未配置 DEEPSEEK_API_KEY' };
}

/** 纯判读：只取人民币余额；available 表示查询成功，不依据余额或 is_available 作额度判档。 */
function evaluateDeepseekBalance(status, body, nowIso) {
  if (status !== 200) return unavailable(`DeepSeek 余额查询失败（HTTP ${status}）`, nowIso);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return unavailable('DeepSeek 余额响应不是对象', nowIso);
  }
  const cny = Array.isArray(body.balance_infos)
    ? body.balance_infos.find((info) => info && info.currency === 'CNY') : null;
  if (!cny) return unavailable('DeepSeek 余额响应缺少人民币（CNY）条目', nowIso);
  const raw = cny.total_balance;
  const balance = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(balance)) return unavailable('DeepSeek 人民币余额不是有效数字', nowIso);
  return { available: true, reason: `DeepSeek 余额 ¥${balance.toFixed(2)}`, balance, sampledAt: nowIso };
}

/** 每次调用实时查询，不缓存余额；凭据与异常原文不进入页面结果。依赖可注入，测试无需真实密钥或联网。 */
async function fetchDeepseekBalance({
  readKey = readDeepseekKey, fetchImpl = globalThis.fetch, now = () => new Date().toISOString(),
} = {}) {
  const sampledAt = now();
  try {
    const key = readKey();
    if (!key.ok) return unavailable('未配置 DEEPSEEK_API_KEY', sampledAt);
    const response = await fetchImpl('https://api.deepseek.com/user/balance', {
      method: 'GET', headers: { Authorization: 'Bearer ' + key.key },
      // 余额服务迟迟不响应时也要让成本页结束加载。
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) return evaluateDeepseekBalance(response.status, null, sampledAt);
    return evaluateDeepseekBalance(response.status, await response.json(), sampledAt);
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'DeepSeek 余额查询超时'
      : error instanceof SyntaxError ? 'DeepSeek 余额响应无法解析' : 'DeepSeek 余额查询异常（网络或读取失败）';
    return unavailable(reason, sampledAt);
  }
}

module.exports = { readDeepseekKey, evaluateDeepseekBalance, fetchDeepseekBalance };
