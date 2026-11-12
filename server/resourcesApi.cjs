'use strict';
/**
 * server/resourcesApi.cjs —— 账号与额度（只在本机生效）的读写接口。
 *
 * 只调派单器仓里已上线的 resources 命令：读 list --json，写 add/login/enable/
 * disable/remove/refresh/clear-limit。起子进程一律数组传参、不经外壳、静默运行，
 * 绝不读任何密钥文件内容，也不把 home / keyFile 回传给页面。
 *
 * 依赖全部注入，便于用假 spawn 做隔离测试。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

// 以后换派单器入口只改这一处。
const DISPATCHER_ENTRY = ['--import', 'tsx', 'scripts/codex/codex-dispatch.ts', 'resources'];

const ACTIONS = new Set(['add', 'login', 'enable', 'disable', 'remove', 'refresh', 'clear-limit']);
const PROVIDERS = new Set(['workbuddy', 'qoder', 'trae', 'codex', 'deepseek', 'claude']);
const KEY_PROVIDERS = new Set(['deepseek', 'claude']);
const ID_RE = /^[a-z]+-[0-9]+$/;
const MODEL_RE = /^[A-Za-z0-9._*-]{1,64}$/;
const TAIL_BYTES = 64 * 1024;
const LIST_STDOUT_BYTES = 2 * 1024 * 1024;
const SLASH = 47;
const BACKSLASH = 92;
const COLON = 58;

function isBlank(value) { return value === undefined || value === null || value === ''; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** 控制字符（含换行、制表符等）：码点 <= 31 或 === 127。 */
function hasControlChars(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
/** 密钥文件路径里禁止出现的字符：NUL、换行、回车、三种引号。 */
function hasForbiddenKeyChars(value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === 0 || code === 10 || code === 13) return true;
    if (ch === "'" || ch === '"' || ch === '`') return true;
  }
  return false;
}
/** 盘符加斜杠/反斜杠开头，或以 / 开头。 */
function isAbsolutePath(value) {
  const c0 = value.charCodeAt(0);
  if (c0 === SLASH) return true;
  const c1 = value.charCodeAt(1);
  const c2 = value.charCodeAt(2);
  const drive = ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) && c1 === COLON;
  return drive && (c2 === SLASH || c2 === BACKSLASH);
}
/** 是否含 .. 路径段（按 / 与反斜杠切分）。 */
function hasDotDotSegment(value) {
  const parts = [];
  let cur = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === SLASH || code === BACKSLASH) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.includes('..');
}

// 白名单校验函数各自独立导出，供测试直接断言。返回 null 表示合规，否则返回错误文案。
// 前端 web/src/utils/resourcesFormat.ts 里的 validateLabel / validateKeyFile 与此处同一套规则。
function validateAction(value) {
  return typeof value === 'string' && ACTIONS.has(value) ? null : '不认识的操作';
}
function validateId(value) {
  return typeof value === 'string' && !hasControlChars(value) && ID_RE.test(value) ? null : '账号编号格式不对';
}
function validateProvider(value) {
  return typeof value === 'string' && !hasControlChars(value) && PROVIDERS.has(value) ? null : '平台不认识';
}
function validateLabel(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') return '名字不合规';
  const text = value.trim();
  if (text.length < 1 || text.length > 20) return '名字不合规';
  if (hasControlChars(value) || text.startsWith('-')) return '名字不合规';
  return null;
}
function validateKeyFile(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') return '密钥文件路径不合规';
  if (value.length > 500) return '密钥文件路径不合规';
  if (hasForbiddenKeyChars(value)) return '密钥文件路径不合规';
  if (!isAbsolutePath(value)) return '密钥文件路径不合规';
  if (hasDotDotSegment(value)) return '密钥文件路径不合规';
  return null;
}
function validateModel(value) {
  if (isBlank(value)) return null;
  return typeof value === 'string' && !hasControlChars(value) && MODEL_RE.test(value) ? null : '模型名不合规';
}

/** 按动作把白名单字段映射成参数数组；不合规返回 { error }，绝不起子进程。 */
function buildAction(body) {
  if (!isRecord(body)) return { error: '请求内容格式有误' };
  const action = body.action;
  const actionError = validateAction(action);
  if (actionError) return { error: actionError };

  const args = [];
  let isLogin = false;
  let loginId = null;

  if (action === 'add') {
    const provider = body.provider;
    const providerError = validateProvider(provider);
    if (providerError) return { error: providerError };
    const label = body.label;
    const labelError = validateLabel(label);
    if (labelError) return { error: labelError };
    const keyFile = body.keyFile;
    if (KEY_PROVIDERS.has(provider)) {
      if (isBlank(keyFile)) return { error: '缺少密钥文件路径' };
      const keyError = validateKeyFile(keyFile);
      if (keyError) return { error: keyError };
    } else if (!isBlank(keyFile)) {
      return { error: '这个平台不用密钥文件' };
    }
    args.push('add', provider);
    if (!isBlank(label)) args.push('--label', label.trim());
    if (KEY_PROVIDERS.has(provider)) args.push('--key-file', keyFile);
    isLogin = true;
  } else if (action === 'clear-limit') {
    const id = body.id;
    const idError = validateId(id);
    if (idError) return { error: idError };
    const model = body.model;
    const modelError = validateModel(model);
    if (modelError) return { error: modelError };
    args.push('clear-limit', id);
    if (!isBlank(model)) args.push('--model', model);
  } else if (action === 'refresh') {
    const id = body.id;
    args.push('refresh');
    if (!isBlank(id)) {
      const idError = validateId(id);
      if (idError) return { error: idError };
      args.push(id);
    }
  } else {
    // login / enable / disable / remove 都需要编号
    const id = body.id;
    const idError = validateId(id);
    if (idError) return { error: idError };
    args.push(action, id);
    if (action === 'login') { isLogin = true; loginId = id; }
  }
  return { args, isLogin, loginId };
}

/** 只保留末尾若干字符的收集器；超限标记 overflow，用于读列表失败判定。 */
function tailCollector(limit) {
  let kept = '';
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      kept += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (kept.length > limit) { overflow = true; kept = kept.slice(-limit); }
    },
    text() { return kept; },
    overflowed() { return overflow; },
  };
}

/** 输出里最后一行非空文本，去掉首尾空白并截 200 字；只回这一行。 */
function lastLine(text) {
  const lines = String(text || '').split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 200);
}
function reasonOf(error) {
  return error && error.message ? String(error.message) : String(error);
}
function killChild(child) {
  try { child.kill(); } catch (_) { /* 子进程可能已退出 */ }
}
/** 登录类后台继续：不杀子进程，继续消费输出，尽量不阻塞服务退出。 */
function detachChild(child) {
  try { child.unref?.(); } catch (_) { /* 假子进程可能没有 unref */ }
  try { child.stdout?.resume?.(); child.stdout?.unref?.(); } catch (_) { /* 忽略 */ }
  try { child.stderr?.resume?.(); child.stderr?.unref?.(); } catch (_) { /* 忽略 */ }
}

function createResourcesApi(deps) {
  const { sendJson, readBody, bodyMax, resolveDispatcherRepo, isCollaboration, isLocalRequest } = deps;
  const runSpawn = deps.spawn || defaultSpawn;
  const fileExists = deps.fileExists || fs.existsSync;
  const readTimeoutMs = deps.readTimeoutMs ?? 60000;
  const actionTimeoutMs = deps.actionTimeoutMs ?? 90000;
  const loginWaitMs = deps.loginWaitMs ?? 20000;
  const readCacheMs = deps.readCacheMs ?? 10000;
  const now = deps.now || Date.now;
  let readCache = null;
  let readers = null;
  let cacheGeneration = 0;
  const invalidateRead = () => { readCache = null; cacheGeneration++; };

  // 写命令互斥：同一时刻只允许一个写命令处在等待窗内。
  let writeBusy = false;
  // 登录中集合：login 按账号编号记，跨等待窗生效，子进程退出后移出。
  const loginInProgress = new Set();

  function startChild(repo, args, stdoutLimit) {
    let child;
    try {
      child = runSpawn(process.execPath, [...DISPATCHER_ENTRY, ...args], {
        cwd: repo,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      return { error };
    }
    const out = tailCollector(stdoutLimit);
    const err = tailCollector(TAIL_BYTES);
    if (child.stdout) child.stdout.on('data', chunk => out.push(chunk));
    if (child.stderr) child.stderr.on('data', chunk => err.push(chunk));
    return { child, out, err };
  }

  function handleRead(repo, res) {
    if (readCache && now() - readCache.at < readCacheMs) { sendJson(res, 200, readCache.body); return; }
    if (readers) { readers.push(res); return; }
    readers = [res];
    const generation = cacheGeneration;
    const finish = (status, body) => {
      if (!readers) return;
      const waiting = readers; readers = null;
      if (status === 200 && readCacheMs > 0 && generation === cacheGeneration) readCache = { at: now(), body };
      for (const response of waiting) sendJson(response, status, body);
    };
    const started = startChild(repo, ['list', '--json'], LIST_STDOUT_BYTES);
    if (started.error) {
      finish(500, { ok: false, error: '启动派单器命令失败:' + reasonOf(started.error) });
      return;
    }
    const { child, out, err } = started;
    let settled = false;
    const complete = (status, body) => { if (settled) return; settled = true; finish(status, body); };
    const timer = setTimeout(() => {
      killChild(child);
      complete(504, { ok: false, error: '派单器命令超时' });
    }, readTimeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      complete(500, { ok: false, error: '启动派单器命令失败:' + reasonOf(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        complete(502, { ok: false, error: lastLine(out.text()) || lastLine(err.text()) });
        return;
      }
      if (out.overflowed()) {
        complete(502, { ok: false, error: '派单器返回的内容读不懂' });
        return;
      }
      let data;
      try { data = JSON.parse(out.text().trim()); }
      catch { complete(502, { ok: false, error: '派单器返回的内容读不懂' }); return; }
      if (!data || typeof data !== 'object' || data.formatVersion !== 1) {
        complete(502, { ok: false, error: '账号数据的格式版本看板不认识' });
        return;
      }
      if (Array.isArray(data.accounts)) {
        data.accounts = data.accounts.map((account) => {
          if (!account || typeof account !== 'object') return account;
          const copy = { ...account };
          delete copy.home;
          delete copy.keyFile;
          return copy;
        });
      }
      complete(200, { ok: true, data });
    });
  }

  function handleWrite(repo, body, res) {
    const built = buildAction(body);
    if (built.error) { sendJson(res, 400, { ok: false, error: built.error }); return; }
    const { args, isLogin, loginId } = built;
    if (loginId && loginInProgress.has(loginId)) {
      sendJson(res, 409, { ok: false, error: '该账号正在登录' });
      return;
    }
    if (writeBusy) {
      sendJson(res, 409, { ok: false, error: '上一个操作还没做完,稍后再试' });
      return;
    }
    writeBusy = true;
    if (loginId) loginInProgress.add(loginId);

    const started = startChild(repo, args, TAIL_BYTES);
    if (started.error) {
      writeBusy = false;
      if (loginId) loginInProgress.delete(loginId);
      sendJson(res, 500, { ok: false, error: '启动派单器命令失败:' + reasonOf(started.error) });
      return;
    }
    const { child, out, err } = started;
    let settled = false;
    const finish = (status, bodyObj) => { if (settled) return; settled = true; sendJson(res, status, bodyObj); };
    // 只释放本请求自己持有的写锁:登录类转后台后锁已交出,子进程迟些退出时不能把别的请求的锁也放掉。
    let lockHeld = true;
    const unlock = () => { if (lockHeld) { lockHeld = false; writeBusy = false; } };
    const release = () => { unlock(); if (loginId) loginInProgress.delete(loginId); };
    const waitMs = isLogin ? loginWaitMs : actionTimeoutMs;
    const timer = setTimeout(() => {
      if (isLogin) {
        // 等待窗内没退出：不杀子进程，返回 pending，后台继续，释放写锁，登录中集合留到子进程退出。
        invalidateRead();
        unlock();
        detachChild(child);
        finish(200, { ok: true, pending: true, lastLine: lastLine(out.text()) });
      } else {
        killChild(child);
        release();
        finish(504, { ok: false, error: '派单器命令超时' });
      }
    }, waitMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      invalidateRead();
      release();
      finish(500, { ok: false, error: '启动派单器命令失败:' + reasonOf(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      invalidateRead();
      release();
      const line = lastLine(out.text()) || lastLine(err.text());
      if (code === 0) finish(200, { ok: true, code: 0, lastLine: line });
      else finish(400, { ok: false, code, error: line });
    });
  }

  function route(subpath, req, res) {
    const isRead = subpath === '' && req.method === 'GET';
    const isWrite = subpath === 'action' && req.method === 'POST';
    if (!deps.demo && !isRead && !isWrite) return false;

    if (isCollaboration) {
      sendJson(res, 404, { ok: false, error: '账号与额度只在本机看板里使用' });
      return true;
    }
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: '请求来源不是本机' });
      return true;
    }
    if (deps.demo) {
      if (isRead) sendJson(res, 200, { ok: true, data: { formatVersion: 1, generatedAt: new Date().toISOString(), accounts: [], providers: [], ladders: { light: [], standard: [], hard: [] } } });
      else sendJson(res, 403, { ok: false, error: '演示实例不能改账号' });
      return true;
    }
    const repo = resolveDispatcherRepo();
    if (!repo) {
      sendJson(res, 503, { ok: false, error: '找不到派单器仓,读不了账号' });
      return true;
    }
    if (!fileExists(path.join(repo, 'scripts', 'codex', 'resource-cli.ts'))) {
      sendJson(res, 503, { ok: false, error: '派单器仓里没有账号管理命令,先把派单器更新到最新' });
      return true;
    }
    if (isRead) { handleRead(repo, res); return true; }

    readBody(req, bodyMax, (error, raw) => {
      if (error) { sendJson(res, 413, { ok: false, error: '请求内容太长' }); return; }
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { sendJson(res, 400, { ok: false, error: '请求内容格式有误' }); return; }
      handleWrite(repo, body, res);
    });
    return true;
  }

  return { route };
}

module.exports = {
  createResourcesApi,
  buildAction,
  validateAction,
  validateId,
  validateProvider,
  validateLabel,
  validateKeyFile,
  validateModel,
  DISPATCHER_ENTRY,
  ACTIONS,
  PROVIDERS,
  KEY_PROVIDERS,
};
