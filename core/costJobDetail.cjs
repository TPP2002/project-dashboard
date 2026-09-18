'use strict';
/**
 * costJobDetail.cjs —— 工单(Codex/DeepSeek 等)按单成本明细(COST-UI-SESSION-DETAIL)。
 *
 * 【数据源】.codex/jobs/<slug>/ 下的 task.json(契约:engine/model/taskId/title)、meta.json
 * (dispatchedAt)、state.json(startedAt/finishedAt)、exec.jsonl(事件流,最后的 result
 * 带权威顶层 usage)。目录约定完全照 server/codexJobs.cjs 与 core/deepseekCostUsage.cjs
 * 已有的读法,不另发明一套。
 *
 * 【jobsRoot 由调用方传入】看板是多项目的,仓在哪由注册表给出(server 侧 resolveProject
 * 之后算 path.join(repo, '.codex', 'jobs') 传进来,与 server/codexApi.cjs 第 32 行同一姿势)。
 * 本模块不 require 项目解析器、不拼 homedir、不出现任何盘符 —— 公开仓红线。
 *
 * 【复用声明】人民币计价直接复用 core/deepseekCostUsage.cjs 的 costRmbOf(价格表 + 四桶
 * 折算)与 isPeakBeijing(高峰判定),不重新定义一分钱怎么算;只读,不改那个冻结模块。
 *
 * 零依赖(core 纪律),仅 Node 内置模块。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { costRmbOf, isPeakBeijing } = require('./deepseekCostUsage.cjs');

/** slug 合法性与 server/codexJobs.cjs 同口径:单个安全目录名。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function readJsonOptional(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null; // 未写完/损坏的工单文件没有可用账目
    throw error;
  }
}

/** token 四桶,口径与 core/deepseekCostUsage.cjs 的 usageBuckets 完全一致(该函数未导出,照抄不另造)。 */
function usageBuckets(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)
    || usage.input_tokens === undefined || usage.output_tokens === undefined) return null;
  const cc = usage.cache_creation;
  if (cc != null && (typeof cc !== 'object' || Array.isArray(cc))) return null;
  const values = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens, cc?.ephemeral_5m_input_tokens, cc?.ephemeral_1h_input_tokens]
    .map((value) => value === undefined ? 0 : value);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const [input, output, cacheRead, cw, cw5m, cw1h] = values;
  const cacheWrite = cw5m || cw1h ? cw5m + cw1h : cw;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * 流式扫一份 exec.jsonl:轮次 = assistant 事件条数;token 取最后一条 result 的顶层 usage
 * (与 deepseekCostUsage 同口径:assistant 行的用量不累加,CLI 的美元字段不参与计价)。
 * @returns {Promise<{turns:number, usage:object|null, usedModel:string|null, reportedUsd:number|null}>}
 */
function readExecSummary(file) {
  return new Promise((resolve) => {
    let input;
    try { input = fs.createReadStream(file, { encoding: 'utf8' }); } catch (_) { return resolve(null); }
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let turns = 0, last = null, model = null;
    lines.on('line', (line) => {
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch (_) { return; } // 忽略写到一半的行
      if (event?.type === 'assistant') {
        turns += 1;
        if (typeof event.message?.model === 'string') model = event.message.model;
      }
      if (event?.type === 'result') last = { event, model };
    });
    const finish = () => {
      const usage = last ? usageBuckets(last.event.usage) : null;
      const rawUsd = last ? Number(last.event.total_cost_usd) : NaN;
      resolve({
        turns,
        usage,
        usedModel: last
          ? (singleModelUsageName(last.event) || last.event.model || last.model || null)
          : model,
        reportedUsd: Number.isFinite(rawUsd) && rawUsd > 0 ? rawUsd : null, // 只展示,不参与任何计价口径
      });
    };
    const onError = () => {
      resolve(null); // 文件不存在或读到一半坏掉:这一单没有可用账目,不拖垮整张表
      try { lines.close(); } catch (_) {}
    };
    lines.once('close', finish);
    lines.once('error', onError);
    input.once('error', onError);
  });
}

/** result.modelUsage 只有一个模型时取它;多模型时不猜怎么拆(与 resultModel 同判据)。 */
function singleModelUsageName(event) {
  const models = event.modelUsage;
  const names = models && typeof models === 'object' && !Array.isArray(models) ? Object.keys(models) : [];
  return names.length === 1 ? names[0] : null;
}

function isoOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** 本机时区的 YYYY-MM-DD(与会话明细筛选、costUsage 按天聚合同一口径),无效给空串。 */
function localDayOf(ts) {
  if (typeof ts !== 'string' || !ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 扫一个 jobsRoot,出按单明细行。缺文件的字段给 null;目录读不出整仓当没有工单。
 * 「级联链」判据(纯落盘事实,不猜):同一张卡(taskId)派过多张工单 → true;
 * 没有卡的工单判不出 → null。同一张卡只有这一单 → false。
 */
async function collectJobRows(jobsRoot) {
  let entries;
  try { entries = fs.readdirSync(jobsRoot, { withFileTypes: true }); } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const slugs = entries.filter((e) => e.isDirectory() && SLUG_RE.test(e.name)).map((e) => e.name);
  const rows = [];
  for (const slug of slugs) {
    const dir = path.join(jobsRoot, slug);
    const task = readJsonOptional(path.join(dir, 'task.json')) || {};
    const meta = readJsonOptional(path.join(dir, 'meta.json')) || {};
    const state = readJsonOptional(path.join(dir, 'state.json')) || {};
    const dispatchedAt = isoOrNull(meta.dispatchedAt);
    const startedAt = isoOrNull(state.startedAt);
    const finishedAt = isoOrNull(state.finishedAt);
    const exec = await readExecSummary(path.join(dir, 'exec.jsonl'));
    const card = typeof task.taskId === 'string' && task.taskId ? task.taskId : null;
    rows.push({
      slug,
      title: typeof task.title === 'string' && task.title ? task.title : null,
      card,
      engine: typeof task.engine === 'string' && task.engine ? task.engine : 'codex', // 老工单没写 engine 的都是标准 Codex 派单
      model: typeof task.model === 'string' && task.model ? task.model : null, // 派单时指定的模型档
      usedModel: exec ? exec.usedModel : null, // 执行日志判读出的实际模型
      dispatchedAt, startedAt, finishedAt,
      running: finishedAt === null,
      durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
      turns: exec ? exec.turns : 0,
      input: exec && exec.usage ? exec.usage.input : 0,
      output: exec && exec.usage ? exec.usage.output : 0,
      cacheRead: exec && exec.usage ? exec.usage.cacheRead : 0,
      cacheWrite: exec && exec.usage ? exec.usage.cacheWrite : 0,
      reportedUsd: exec ? exec.reportedUsd : null,
      peak: dispatchedAt !== null ? isPeakBeijing(dispatchedAt) : null,
      chain: null, // 下面按同卡单数回填
    });
  }
  const byCard = new Map();
  for (const row of rows) {
    if (!row.card) continue;
    byCard.set(row.card, (byCard.get(row.card) || 0) + 1);
  }
  for (const row of rows) {
    if (row.card) row.chain = (byCard.get(row.card) || 0) > 1;
  }
  rows.sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')));
  return rows;
}

/** 人民币花销(只对判得出 DeepSeek 价目的单有值);costRmbOf 对未知模型/无效用量一律给 null,不造零元。 */
function jobCostRmb(row) {
  if (!row || typeof row.usedModel !== 'string') return null;
  return costRmbOf(
    {
      input_tokens: row.input, output_tokens: row.output,
      cache_read_input_tokens: row.cacheRead, cache_creation_input_tokens: row.cacheWrite,
    },
    row.usedModel,
    row.peak === true,
  );
}

/**
 * 工单明细筛选(纯函数):fromDate/toDate 按派单日(含端点)卡;engine/model 精确匹配
 * (model 命中「实际判读」或「工单指定」任一侧);card 精确等于看板卡 id。缺省不设那侧。
 * @param {Array} rows collectJobRows 产出
 * @param {{fromDate?:string, toDate?:string, engine?:string, model?:string, card?:string}} [filters]
 */
function filterJobRows(rows, filters = {}) {
  const { fromDate = '', toDate = '', engine = '', model = '', card = '' } = filters || {};
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => {
    if (!row) return false;
    if (engine && row.engine !== engine) return false;
    if (card && row.card !== card) return false;
    if (model && row.model !== model && row.usedModel !== model) return false;
    const day = localDayOf(row.dispatchedAt); // 本机时区口径,与按天图一致(UTC 切前 10 位会把晚间记录算到前一天)
    if (fromDate && !(day && day >= fromDate)) return false;
    if (toDate && !(day && day <= toDate)) return false;
    return true;
  });
}

/** 筛后合计:jobs/轮次/四类 token/人民币(只累加有值的单,并给出有值的单数)。 */
function summarizeJobRows(rows) {
  const sum = { jobs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costRmb: 0, costRmbJobs: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    sum.jobs++;
    sum.turns += row.turns || 0;
    sum.input += row.input || 0;
    sum.output += row.output || 0;
    sum.cacheRead += row.cacheRead || 0;
    sum.cacheWrite += row.cacheWrite || 0;
    const rmb = jobCostRmb(row);
    if (rmb !== null) {
      sum.costRmb += rmb;
      sum.costRmbJobs++;
    }
  }
  return sum;
}

/** 筛选控件候选:引擎、模型(实际∪指定)、卡,各自字典序。 */
function jobFilterOptions(rows) {
  const engines = new Set();
  const models = new Set();
  const cards = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    if (row.engine) engines.add(row.engine);
    if (row.model) models.add(row.model);
    if (row.usedModel) models.add(row.usedModel);
    if (row.card) cards.add(row.card);
  }
  return { engines: [...engines].sort(), models: [...models].sort(), cards: [...cards].sort() };
}

module.exports = {
  collectJobRows,
  filterJobRows,
  jobCostRmb,
  jobFilterOptions,
  summarizeJobRows,
};
