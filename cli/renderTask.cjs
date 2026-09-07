'use strict';
/**
 * renderTask.cjs —— 查询命令(list / show)的渲染层(AUD-CLI-BRIEF-AND-HELP,审计 §4-A4)。
 *
 * 【病根】旧 list 把 `title`(给模型看的技术说明,实测最长 2166 字)整段回吐、且默认含已完工;
 * 旧 show 无条件 `JSON.stringify(task)`。AI 每问一次看板就被塞上万 token,全是它当下不需要的。
 * 【治法】默认只给"扫一眼要判断的东西",全量改成显式索取(`--all` / `--full` / `--fields`)。
 * 渲染独立成文件:commands.cjs 只管取数,格式怎么排在这里改,两件事互不牵连。
 */
const { emojiFor } = require('../core/boardSchema.cjs');
const { humanTitle, PLAIN_TITLE_TRUNCATE_LEN } = require('../core/taskTitle.cjs');
const { displayWidth, padRight, padLeft } = require('../core/termText.cjs');

/** 默认视图里藏起来的终态(显式 --status / --all 时不生效)。 */
const HIDDEN_BY_DEFAULT = ['已完工'];

/** --fields 的人性化别名 → 真实字段名。写 `branch` 比写 `gitBranch` 顺手。 */
const FIELD_ALIASES = {
  pct: 'percent', branch: 'gitBranch', plain: 'plainTitle', spec: 'title',
  model: 'modelHint', next: 'nextMilestone', pr: 'prNumbers', scope: 'fileScope',
  done: 'dates.done', start: 'dates.start',
};

/** 取一个字段(支持别名与一级点路径);取不到一律 '-',不报错——查询命令不该因为写错列名就整条崩掉。 */
function readField(task, rawName) {
  const name = FIELD_ALIASES[rawName] || rawName;
  let v = task;
  for (const seg of String(name).split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') { v = undefined; break; }
    v = v[seg];
  }
  if (v === null || v === undefined || v === '') return '-';
  if (Array.isArray(v)) return v.length ? v.map(String).join(',') : '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 按 --status / --wave / 默认藏终态 过滤。
 * 显式点名 --status 时不再套默认过滤:调用方明说"我就要已完工",再藏起来就是耍人。
 */
function filterTasks(tasks, opts) {
  let out = tasks || [];
  if (opts.status) out = out.filter((t) => t.status === opts.status);
  if (opts.wave !== undefined) out = out.filter((t) => String(t.wave) === String(opts.wave));
  if (!opts.all && !opts.status) out = out.filter((t) => !HIDDEN_BY_DEFAULT.includes(t.status));
  return out;
}

/** 默认列:够判断"这张卡是谁的、到哪了、能不能碰",再多一个字都是浪费。 */
const DEFAULT_FIELDS = ['id', 'status', 'percent', 'branch', 'human'];
const BRIEF_FIELDS = ['id', 'status', 'percent'];

/**
 * 每列的显示宽度上限(终端列数;人话标题那列与 humanTitle 的 60 字截断口径对齐)。
 * 【为什么必须封顶】列宽取全表最大值,一个超长单元格会把【每一行】都撑到那么宽:
 * 实测某项目一张卡的 gitBranch 攒了 3284 字符,72 行全被补成 3284 列 —— 24 万字符的空格,
 * 比要传达的信息还多两个数量级。封顶后超出部分用 … 明示截断,要原值去 `show <卡号> --full`。
 */
// human 那列按「60 个中文字 + 省略号」折算成终端列数,别把 humanTitle 刚截好的标题又切一刀。
const MAX_COL = { id: 34, status: 8, percent: 5, branch: 30, human: PLAIN_TITLE_TRUNCATE_LEN * 2 + 2 };
const DEFAULT_MAX_COL = 60;

/** 截到指定显示宽度,截了就带一个 …(不许无声吞字)。 */
function clip(s, maxWidth) {
  const str = String(s);
  if (displayWidth(str) <= maxWidth) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}

/** 单元格取值:`human` 是派生列(人话标题,老卡回退截断的技术说明),其余走 readField。 */
function cell(task, field) {
  const raw = field === 'human' ? (humanTitle(task) || '-')
    : (field === 'percent' || field === 'pct') ? `${task.percent || 0}%`
      : readField(task, field);
  return clip(raw, MAX_COL[field] === undefined ? DEFAULT_MAX_COL : MAX_COL[field]);
}

/**
 * list 的表格。
 * @param {object[]} tasks 已过滤的任务
 * @param {{fields?:string[]}} opts
 */
function renderRows(tasks, fields) {
  const grid = tasks.map((t) => fields.map((f) => cell(t, f)));
  const widths = fields.map((_, i) => Math.max(...grid.map((row) => displayWidth(row[i])), 0));
  return tasks.map((t, r) => {
    const cells = grid[r].map((v, i) => (
      // 最后一列不补空格(补了只是行尾拖白);数值列右对齐,其余左对齐。
      i === fields.length - 1 ? v
        : fields[i] === 'percent' ? padLeft(v, widths[i]) : padRight(v, widths[i])
    ));
    return `${emojiFor(t.status)} ${cells.join('  ')}`;
  });
}

/** `--fields a,b` 解析:允许逗号/空格混写,空串当没给。 */
function parseFields(raw) {
  if (raw === undefined || raw === true) return null;
  const list = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

/**
 * list 全文 = 项目抬头 + 统计行 + 表格 + 一行开关指路。
 * @param {{projName:string, statsLine:string, tasks:object[], opts:object}} input
 */
function renderList({ projName, statsLine, tasks, opts }) {
  const shown = filterTasks(tasks, opts);
  const hidden = (tasks || []).length - shown.length;
  const fields = parseFields(opts.fields) || (opts.brief ? BRIEF_FIELDS : DEFAULT_FIELDS);
  const body = shown.length ? renderRows(shown, fields).join('\n') : '（没有符合条件的任务）';
  const hint = (hidden > 0 ? `隐藏 ${hidden} 张（--all 看全部）｜` : '')
    + '列可选：--brief（只 id/状态/进度）· --fields id,status,percent,branch,plain'
    + '｜单卡开工信息：brief <卡号>';
  return `${projName}  ${statsLine}\n${body}\n—— ${hint}`;
}

/**
 * show 的精简卡:够回答"这张卡是什么、谁在做、卡在哪、下一步是什么"。
 * 技术说明、依赖、文档、决策细节一律不进这里——要么 `--full`,要么 `brief`(开工任务书)。
 */
function renderShowCard(task, { pid, cliHint } = {}) {
  const t = task || {};
  const lines = [`${t.id}  ${emojiFor(t.status)} ${t.status || '-'} ${t.percent || 0}%`];
  lines.push(`人话标题：${humanTitle(t) || '（这张卡还没写人话标题）'}`);
  const branches = (t.gitBranch || []).map(String);
  lines.push(`分支：${branches.length ? branches.join(',') : '-'}`);
  if (t.nextMilestone) lines.push(`下一步：${t.nextMilestone}`);
  if (t.blockReason) lines.push(`卡在：${t.blockReason}`);
  const open = (t.decisions || []).filter((d) => d.answer === null || d.answer === undefined);
  if (open.length) {
    lines.push(`待拍板 ${open.length} 条（没拍完不许开工）：`);
    for (const d of open) {
      lines.push(`  ❓ ${d.id} ${d.question}`);
      lines.push(`     选项：${(d.options || []).join(' / ')}｜推荐：${d.recommended || '-'}`);
    }
  }
  const proj = pid ? ` --project ${pid}` : '';
  lines.push(`—— 精简卡。技术说明/依赖/文档/全部字段：加 --full；开工任务书：`
    + `${cliHint ? cliHint + ' ' : ''}brief ${t.id}${proj}`);
  return lines.join('\n');
}

module.exports = {
  renderList, renderShowCard, filterTasks, readField, parseFields, clip,
  HIDDEN_BY_DEFAULT, FIELD_ALIASES, DEFAULT_FIELDS, BRIEF_FIELDS, MAX_COL, DEFAULT_MAX_COL,
};
