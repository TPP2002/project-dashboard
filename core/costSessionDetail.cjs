'use strict';
/**
 * costSessionDetail.cjs —— Claude 对话明细的纯函数层(COST-UI-SESSION-DETAIL)。
 *
 * 【为什么单独一个文件】会话明细要做的「所属卡判定」「按日期/模型/卡筛选」「筛后合计」
 * 必须是能被 node --test 直接机验的纯函数,不许只活在 Vue 组件里;
 * costUsage.cjs(扫描聚合)与 server/server.cjs(接口)都从这里取判据,前端只渲染。
 *
 * 零依赖(core 纪律):本文件不 require 任何东西,不做任何 IO。
 */

/**
 * 从会话工作目录判「所属看板卡」。
 *
 * 【判据】把 cwd 按路径分隔符切段,某一段(不区分大小写)恰好等于某张卡的 id 才算命中 ——
 * 派单 worktree 的目录名就是卡 id 的小写。从最深的段往回找,命中即返回卡 id 原样;
 * 对不上一律 null,不许猜:主仓检出目录、普通项目目录都不该被硬安到某张卡头上。
 * @param {string|null} cwd 流水记录里的工作目录(判不出给 null)
 * @param {string[]} cardIds 看板卡 id 清单(由调用方从 board 读出传入)
 * @returns {string|null}
 */
function cardForSession(cwd, cardIds) {
  if (typeof cwd !== 'string' || !cwd || !Array.isArray(cardIds) || !cardIds.length) return null;
  const wanted = new Map();
  for (const id of cardIds) {
    if (typeof id === 'string' && id) wanted.set(id.toLowerCase(), id);
  }
  if (!wanted.size) return null;
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const hit = wanted.get(segments[i].toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * 模型名归一:剥掉 claude- 前缀与 -YYYYMMDD 日期后缀,与前端 shortModel 同款规则。
 * 同一模型只差版本日期后缀时,候选项里不该出两个长得一样的选项。
 */
function shortModelName(m) {
  return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * 本机时区的 YYYY-MM-DD(与 costUsage.cjs 按天聚合的 localDate 同一口径):
 * 按 UTC 取前 10 位会把晚上八点以后的记录算到前一天,「按天图」和「按日期筛」就对不上。
 * 无效时间给空串(筛不动那一侧,不许猜)。
 */
function dayOf(ts) {
  if (typeof ts !== 'string' || !ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 会话明细行筛选(纯函数,server 侧调用,机验覆盖)。
 *
 * 【日期口径】会话一行可能跨多天(起止时间取窗口内的首末记录),所以按「有交集」算:
 * 会话的 [起始日, 结束日] 与 [fromDate, toDate] 有重叠就留下 —— 追查「某天烧的钱」时,
 * 跨天会话的那部分消耗不会被漏掉。fromDate/toDate 为 'YYYY-MM-DD'(本机时区),缺省表示不设那一侧。
 * model 按归一后的名字(剥前缀/日期后缀)命中该会话用过的任一模型,全名与短名都筛得到;
 * card 精确等于所属卡 id(判不出卡的行筛不出来)。
 * @param {Array} rows getUsage 产出的 sessionRows
 * @param {{fromDate?:string, toDate?:string, model?:string, card?:string}} [filters]
 */
function filterSessions(rows, filters = {}) {
  const { fromDate = '', toDate = '', model = '', card = '' } = filters || {};
  const want = shortModelName(model);
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => {
    if (!row) return false;
    if (want && !(Array.isArray(row.models) && row.models.some((m) => shortModelName(m) === want))) return false;
    if (card && row.card !== card) return false;
    const from = dayOf(row.startedAt);
    const to = dayOf(row.endedAt);
    if (fromDate && !(to && to >= fromDate)) return false;
    if (toDate && !(from && from <= toDate)) return false;
    return true;
  });
}

/**
 * 筛后的合计(「筛完还能看见合计」是这一单的硬要求):四类 token、轮次、上下文负载、等价美元。
 * avgContext 重新按合计口径算(Σ上下文 ÷ Σ轮次),不平均各行的平均数。
 */
function summarizeSessionRows(rows) {
  const sum = {
    sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    compactions: 0, contextSum: 0, usd: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    sum.sessions++;
    sum.turns += row.turns || 0;
    sum.input += row.input || 0;
    sum.output += row.output || 0;
    sum.cacheRead += row.cacheRead || 0;
    sum.cacheWrite += row.cacheWrite || 0;
    sum.compactions += row.compactions || 0;
    sum.contextSum += (row.turns || 0) * (row.avgContext || 0);
    sum.usd += row.usd || 0;
  }
  sum.avgContext = sum.turns > 0 ? sum.contextSum / sum.turns : 0;
  return sum;
}

/**
 * 筛选控件的候选项:从全部行(未筛)取出现过的模型与卡,各自字典序。
 * 模型先按 shortModelName 归一再去重 —— 带日期后缀的同一模型在前端剥掉后缀后
 * 显示完全一样,候选出两个一样的选项只会让人困惑;筛选用同一归一规则,短名照样筛得到。
 */
function sessionFilterOptions(rows) {
  const models = new Set();
  const cards = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    for (const m of row.models || []) {
      if (m) models.add(shortModelName(m));
    }
    if (row.card) cards.add(row.card);
  }
  return { models: [...models].sort(), cards: [...cards].sort() };
}

module.exports = {
  cardForSession,
  filterSessions,
  sessionFilterOptions,
  summarizeSessionRows,
};
