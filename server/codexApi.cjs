'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getJobDetail, isRedispatchBlocked, isValidSlug, listJobs, parseTaskJson } = require('./codexJobs.cjs');
const { attachLiveness } = require('./codexJobHealth.cjs');
const { spawnDispatchCli, waitForChild } = require('./codexProcess.cjs');
const { createCodexSessionApi } = require('./codexSessionApi.cjs');

const MESSAGE_MAX = 8000;

function createCodexApi({
  resolveRogueRepo, readRegistry, dashboardRoot, sessionsRoot,
  readBody, sendJson, sendText, bodyMax,
}) {
  const activeDispatches = new Set();

  function context(res) {
    const repo = resolveRogueRepo();
    if (!repo) {
      sendJson(res, 404, { ok: false, error: 'registry.json 中没有可用的 projects.rogue.mainRepo' });
      return null;
    }
    return { repo, jobsRoot: path.join(repo, '.codex', 'jobs') };
  }

  function validSlug(value, res) {
    if (isValidSlug(value)) return value;
    sendJson(res, 400, { ok: false, error: 'slug 只允许小写字母、数字和连字符' });
    return null;
  }

  function jsonBody(req, res, callback) {
    readBody(req, bodyMax, (error, raw) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      let body;
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      callback(body);
    });
  }

  function waitForCodex(repo, args, callback) {
    let child;
    try { child = spawnDispatchCli(repo, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { callback({ kind: 'spawn', error }); return; }
    waitForChild(child, callback);
  }

  function commandError(res, result) {
    if (result.kind === 'timeout') {
      return sendJson(res, 504, { ok: false, error: 'Codex 命令超过 10 分钟，已停止等待' });
    }
    if (result.kind === 'spawn') {
      return sendJson(res, 500, { ok: false, error: '启动 Codex 命令失败：' + result.error.message });
    }
    const detail = String(result.stderr || result.stdout || `子进程退出码 ${result.code}`).trim().slice(0, MESSAGE_MAX);
    return sendJson(res, 400, { ok: false, error: detail });
  }

  function currentJobs() {
    const repo = resolveRogueRepo();
    if (!repo) return [];
    // 这里没有会话数据,只走「进程没了」「早该收工却没收尾」两条铁证;
    // 「长时间没动静」这条软判据要扫会话文件,留给战报那条路径算。
    return attachLiveness(listJobs(path.join(repo, '.codex', 'jobs')), { nowMs: Date.now() });
  }

  const sessionApi = createCodexSessionApi({
    readBody, sendJson, sendText, bodyMax, dashboardRoot, sessionsRoot, readRegistry,
    getJobs: currentJobs, commandError,
  });

  function handleJobs(res) {
    const ctx = context(res);
    if (!ctx) return;
    sendJson(res, 200, attachLiveness(listJobs(ctx.jobsRoot), { nowMs: Date.now() }));
  }

  function handleJob(res, query) {
    const slug = validSlug(query.slug, res);
    if (!slug) return;
    const ctx = context(res);
    if (!ctx) return;
    const detail = getJobDetail(ctx.jobsRoot, slug, { includeTail: query.tail !== '0' });
    if (!detail) return sendJson(res, 404, { ok: false, error: `工单 ${slug} 不存在` });
    sendJson(res, 200, detail);
  }

  function handleTask(res, query) {
    const slug = validSlug(query.slug, res);
    if (!slug) return;
    const ctx = context(res);
    if (!ctx) return;
    const taskPath = path.join(ctx.repo, '.codex', 'jobs', `${slug}.json`);
    let text;
    try { text = fs.readFileSync(taskPath, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: `工单文件 ${slug}.json 不存在` });
      return sendJson(res, 500, { ok: false, error: '读取工单 JSON 失败：' + error.message });
    }
    sendJson(res, 200, { slug, text });
  }

  function handleSay(req, res) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
      }
      if (body.message.length > MESSAGE_MAX) {
        return sendJson(res, 400, { ok: false, error: `message 不能超过 ${MESSAGE_MAX} 字符` });
      }
      const ctx = context(res);
      if (!ctx) return;
      if (!fs.existsSync(path.join(ctx.jobsRoot, slug))) {
        return sendJson(res, 404, { ok: false, error: `工单 ${slug} 不存在` });
      }
      waitForCodex(ctx.repo, ['say', slug, body.message], (result) => {
        if (result.kind !== 'exit' || result.code !== 0) return commandError(res, result);
        sendText(res, 200, result.stdout, 'text/plain; charset=utf-8');
      });
    });
  }

  function handleDispatch(req, res) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
      const ctx = context(res);
      if (!ctx) return;
      const task = `.codex/jobs/${slug}.json`;
      const taskPath = path.join(ctx.repo, task);
      const detail = getJobDetail(ctx.jobsRoot, slug, { includeTail: false });
      if (isRedispatchBlocked(detail ? { finishedAt: detail.running ? null : 'done' } : { finishedAt: 'new' }, activeDispatches.has(slug))) {
        return sendJson(res, 409, { ok: false, error: `工单 ${slug} 仍在运行，不能重复派发` });
      }
      if (body.taskText !== undefined) {
        try { parseTaskJson(body.taskText); }
        catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
        const temporary = `${taskPath}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temporary, body.taskText, 'utf8');
          fs.renameSync(temporary, taskPath);
        } catch (error) {
          try { fs.unlinkSync(temporary); } catch (_) {}
          return sendJson(res, 500, { ok: false, error: '保存工单 JSON 失败：' + error.message });
        }
      }
      if (!fs.existsSync(taskPath)) {
        return sendJson(res, 404, { ok: false, error: `工单文件 ${task} 不存在` });
      }
      let child;
      activeDispatches.add(slug);
      try { child = spawnDispatchCli(ctx.repo, ['dispatch', '--task', task], { detached: true, stdio: 'ignore' }); }
      catch (error) {
        activeDispatches.delete(slug);
        return sendJson(res, 500, { ok: false, error: '启动派单器失败：' + error.message });
      }
      let replied = false;
      child.once('close', () => activeDispatches.delete(slug));
      child.once('spawn', () => {
        if (replied) return;
        replied = true;
        child.unref();
        sendJson(res, 202, { ok: true, slug });
      });
      child.once('error', (error) => {
        activeDispatches.delete(slug);
        if (replied) return;
        replied = true;
        sendJson(res, 500, { ok: false, error: '启动派单器失败：' + error.message });
      });
    });
  }

  function handleCollect(req, res) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
      const ctx = context(res);
      if (!ctx) return;
      const dir = path.join(ctx.jobsRoot, slug);
      if (!fs.existsSync(dir)) return sendJson(res, 404, { ok: false, error: `工单 ${slug} 不存在` });
      waitForCodex(ctx.repo, ['collect', slug], (result) => {
        if (result.kind !== 'exit') return commandError(res, result);
        if (result.code !== 0 && !fs.existsSync(path.join(dir, 'verdict.json'))) return commandError(res, result);
        sendText(res, 200, result.stdout, 'text/plain; charset=utf-8');
      });
    });
  }

  /** 返回 true 表示本模块已接管请求，异步响应也算已接管。 */
  function route(action, req, res, query) {
    if (sessionApi.route(action, req, res, query)) return true;
    if (action === 'jobs' && req.method === 'GET') { handleJobs(res); return true; }
    if (action === 'job' && req.method === 'GET') { handleJob(res, query); return true; }
    if (action === 'task' && req.method === 'GET') { handleTask(res, query); return true; }
    if (action === 'say' && req.method === 'POST') { handleSay(req, res); return true; }
    if (action === 'dispatch' && req.method === 'POST') { handleDispatch(req, res); return true; }
    if (action === 'collect' && req.method === 'POST') { handleCollect(req, res); return true; }
    return false;
  }

  return { getCostUsage: sessionApi.getCostUsage, getQuota: sessionApi.getQuota, route };
}

module.exports = { createCodexApi };
