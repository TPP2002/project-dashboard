'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getJobDetail, isRedispatchBlocked, isValidSlug, listJobs, parseTaskJson } = require('./codexJobs.cjs');
const { attachLiveness } = require('./codexJobHealth.cjs');
const { getJobSessionSummary } = require('./codexSessions.cjs');
const { spawnDispatchCli, waitForChild } = require('./codexProcess.cjs');
const { createCodexSessionApi } = require('./codexSessionApi.cjs');
const deepseekCostUsage = require('../core/deepseekCostUsage.cjs');
const deepseekBalance = require('../core/deepseekBalance.cjs');

const MESSAGE_MAX = 8000;

function createCodexApi({
  resolveRepo, readRegistry, dashboardRoot, sessionsRoot, registryPath,
  readBody, sendJson, sendText, bodyMax,
}) {
  const activeDispatches = new Set();

  function context(res, query) {
    const projectId = query.project;
    if (typeof projectId !== 'string' || !projectId.trim()) {
      sendJson(res, 400, { ok: false, error: '缺 project' });
      return null;
    }
    const repo = resolveRepo(projectId);
    if (!repo) {
      sendJson(res, 404, { ok: false, error: `项目 ${projectId} 的代码仓读不出` });
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

  function currentJobs(repo) {
    if (!repo) return [];
    // 这里没有会话数据,只走「进程没了」「早该收工却没收尾」两条铁证;
    // 「长时间没动静」这条软判据要扫会话文件,留给战报那条路径算。
    return attachLiveness(listJobs(path.join(repo, '.codex', 'jobs')), { nowMs: Date.now() });
  }

  // 每个请求绑定自己的仓库，异步续聊也不会被另一个项目的请求改写上下文。
  function sessionApiFor(repo) {
    return createCodexSessionApi({
      readBody, sendJson, sendText, bodyMax, dashboardRoot, sessionsRoot, readRegistry,
      getJobs: () => currentJobs(repo), commandError,
    });
  }
  // 成本与额度扫描会话文件，不需要工单仓库。
  const sessionApi = sessionApiFor();

  function handleJobs(res, ctx) {
    sendJson(res, 200, attachLiveness(listJobs(ctx.jobsRoot), { nowMs: Date.now() }));
  }

  function handleJob(res, query, ctx) {
    const slug = validSlug(query.slug, res);
    if (!slug) return;
    const detail = getJobDetail(ctx.jobsRoot, slug, { includeTail: query.tail !== '0' });
    if (!detail) return sendJson(res, 404, { ok: false, error: `工单 ${slug} 不存在` });
    // 详情只看这一个工单,查它自己那一份会话文件很便宜,不必像列表那样为了省成本放弃软判据
    // (CODEX-LIVENESS-VERDICT-SPLIT,2026-09-02)——否则战报已经标红「很久没动静」,
    // 用户从战报点进详情核实,详情却因为查不到这条软证据而说「还在干」,自相矛盾。
    const session = detail.threadId ? getJobSessionSummary(detail.threadId, { sessionsRoot }) : null;
    sendJson(res, 200, attachLiveness([detail], { nowMs: Date.now(), sessions: session ? [session] : undefined })[0]);
  }

  function handleTask(res, query, ctx) {
    const slug = validSlug(query.slug, res);
    if (!slug) return;
    const taskPath = path.join(ctx.repo, '.codex', 'jobs', `${slug}.json`);
    let text;
    try { text = fs.readFileSync(taskPath, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: `工单文件 ${slug}.json 不存在` });
      return sendJson(res, 500, { ok: false, error: '读取工单 JSON 失败：' + error.message });
    }
    sendJson(res, 200, { slug, text });
  }

  function handleSay(req, res, ctx) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
      }
      if (body.message.length > MESSAGE_MAX) {
        return sendJson(res, 400, { ok: false, error: `message 不能超过 ${MESSAGE_MAX} 字符` });
      }
      if (!fs.existsSync(path.join(ctx.jobsRoot, slug))) {
        return sendJson(res, 404, { ok: false, error: `工单 ${slug} 不存在` });
      }
      waitForCodex(ctx.repo, ['say', slug, body.message], (result) => {
        if (result.kind !== 'exit' || result.code !== 0) return commandError(res, result);
        sendText(res, 200, result.stdout, 'text/plain; charset=utf-8');
      });
    });
  }

  function handleDispatch(req, res, ctx) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
      const task = `.codex/jobs/${slug}.json`;
      const taskPath = path.join(ctx.repo, task);
      const detail = getJobDetail(ctx.jobsRoot, slug, { includeTail: false });
      // 这一步以前漏了活性判定(列表接口和详情接口都做了,唯独派单这里没做),于是服务端看不见
      // 「失联」这一态,把早就死掉的单一直当成仍在运行拦着 —— CODEX-STALLED-JOB-REDISPATCH。
      // 同样要传 sessions,否则「久无动静」这条软判据在这条路径上永远查不到,下面的提示文案
      // 分支成了死代码,和详情页(handleJob)各说各话 —— CODEX-DISPATCH-CONFIRM-MISSING-SESSION-DATA。
      const session = detail?.threadId ? getJobSessionSummary(detail.threadId, { sessionsRoot }) : null;
      const health = detail
        ? attachLiveness([detail], { nowMs: Date.now(), sessions: session ? [session] : undefined })[0]
        : null;
      const state = detail ? { finishedAt: detail.running ? null : 'done' } : { finishedAt: 'new' };
      const dispatchKey = path.join(ctx.jobsRoot, slug);
      const inFlight = activeDispatches.has(dispatchKey);
      if (isRedispatchBlocked(state, inFlight, health?.confirmedDead === true)) {
        // 文案要说清「为什么拦」:对失联单只说"仍在运行"是误导 —— 面板明明已经标红说它失联了。
        const reason = inFlight ? '已经有一个派单进程在跑'
          : health?.liveness === 'stalled'
            ? `只是很久没有新动静(${health.stalledReason})，还不能确定它真的死了；`
              + '硬派会有重复派单烧额度的风险，请先确认它确实停了'
            : '它还在跑';
        return sendJson(res, 409, { ok: false, error: `工单 ${slug} 不能重复派发：${reason}` });
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
      activeDispatches.add(dispatchKey);
      try { child = spawnDispatchCli(ctx.repo, ['dispatch', '--task', task], { detached: true, stdio: 'ignore' }); }
      catch (error) {
        activeDispatches.delete(dispatchKey);
        return sendJson(res, 500, { ok: false, error: '启动派单器失败：' + error.message });
      }
      let replied = false;
      child.once('close', () => activeDispatches.delete(dispatchKey));
      child.once('spawn', () => {
        if (replied) return;
        replied = true;
        child.unref();
        sendJson(res, 202, { ok: true, slug });
      });
      child.once('error', (error) => {
        activeDispatches.delete(dispatchKey);
        if (replied) return;
        replied = true;
        sendJson(res, 500, { ok: false, error: '启动派单器失败：' + error.message });
      });
    });
  }

  function handleCollect(req, res, ctx) {
    jsonBody(req, res, (body) => {
      const slug = validSlug(body.slug, res);
      if (!slug) return;
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
    const ctx = context(res, query);
    if (!ctx) return true;
    if (sessionApiFor(ctx.repo).route(action, req, res, query)) return true;
    if (action === 'jobs' && req.method === 'GET') { handleJobs(res, ctx); return true; }
    if (action === 'job' && req.method === 'GET') { handleJob(res, query, ctx); return true; }
    if (action === 'task' && req.method === 'GET') { handleTask(res, query, ctx); return true; }
    if (action === 'say' && req.method === 'POST') { handleSay(req, res, ctx); return true; }
    if (action === 'dispatch' && req.method === 'POST') { handleDispatch(req, res, ctx); return true; }
    if (action === 'collect' && req.method === 'POST') { handleCollect(req, res, ctx); return true; }
    return false;
  }

  return {
    getCostUsage: sessionApi.getCostUsage,
    getDeepseekUsage: (days, projectId) => deepseekCostUsage.getDeepseekUsage({ days, projectId, registryPath }),
    getDeepseekBalance: () => deepseekBalance.fetchDeepseekBalance(),
    getQuota: sessionApi.getQuota,
    route,
  };
}

module.exports = { createCodexApi };
