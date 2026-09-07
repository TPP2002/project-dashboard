'use strict';
/**
 * taskSignal.cjs —— 「这张卡此刻还算不算数」的单一真相源。
 *
 * 【为什么要有它】看板上一大半"要你处理"的数字,都建立在同一个没人写下来的判断上:
 * 这张卡现在还算数吗?——已经完工的不算、负责人自己按了暂停的另算、上游早做完了的不算被挡。
 * 这个判断此前散在三个视图里各写各的(而且都只写了一半),0907 全景审计实测的后果:
 *   ① 总览 KPI「需要你处理」=307,其中 258 是"卡住"——暂缓卡、别的项目的卡、
 *      完工卡上残留的 blockReason 全被算进去,负责人第一眼看到的就是个假数字(审计 B1);
 *   ② 风险面板「阻塞」列把已完工卡也列出来(审计 B2);
 *   ③ 占用防撞把完工卡的历史分支算成 36 处冲突,真冲突被淹在里面(审计 B2)。
 * 数字一旦不可信,负责人就不看了——看板最核心的用途(不看代码也能掌控全局)当场失效。
 *
 * 【口径:三条线,别混用】
 *   · 结案(settled)= 已完工 / 已作废 —— 不再需要任何人做任何事;
 *   · 搁置(parked)= 暂缓 —— 负责人自己按下的暂停键,是"我知道、先不做",不是"有人挡我";
 *   · 活跃(active)= 既没结案也没搁置 —— 只有活跃卡才配进"要你处理"。
 * 另有一条独立的线:**占地盘(occupying)= 没结案**。暂缓卡不活跃,但它的分支/worktree
 * 还实实在在检出着,别人抢同一个照样撞;只有完工卡的分支才是纯历史遗迹。
 * 把"活跃"和"占地盘"当成一件事,就会两头错:要么把暂缓卡算成要你处理,要么放过真撞车。
 *
 * 【单一真相源】前端不许另抄:vite 用 toEsmSource() 把本文件内联成虚拟模块 'virtual:task-signal'
 * (同 boardSchema / generatedArtifacts 的做法),CLI / server 直接 require。
 */

/** 结案:这张卡不再需要任何人做任何事。('已作废' 尚未进 core STATUS 枚举,先认着,免得将来加了又漏一处) */
const SETTLED_STATUSES = ['已完工', '已作废'];
/** 搁置:负责人自己按的暂停键。 */
const PARKED_STATUS = '暂缓';
/** 正在有人干的状态。 */
const BUILDING_STATUS = '施工中';

function isSettled(task) {
  return !!task && SETTLED_STATUSES.indexOf(task.status) >= 0;
}

function isParked(task) {
  return !!task && task.status === PARKED_STATUS;
}

/** 活跃 = 既没结案也没搁置。只有活跃卡才配进"需要你处理"。 */
function isActive(task) {
  return !!task && !isSettled(task) && !isParked(task);
}

/** 还占着分支 / worktree / 文件域。暂缓卡照旧算占——它的检出还在盘上。 */
function isOccupying(task) {
  return !!task && !isSettled(task);
}

/**
 * 把一块板预处理成判信号要用的索引,免得每张卡都重扫一遍全板(百来张卡的板上是 O(n²) 与 O(n) 的差别)。
 * @returns {{ settledById: Map<string, boolean>, lastActivityById: Map<string, string> }}
 */
function indexBoard(board) {
  const settledById = new Map();
  const lastActivityById = new Map();
  const tasks = (board && board.tasks) || [];
  for (const task of tasks) settledById.set(task.id, isSettled(task));
  for (const entry of (board && board.activity) || []) {
    if (!entry || !entry.taskId || !entry.ts) continue;
    const prev = lastActivityById.get(entry.taskId);
    if (!prev || entry.ts > prev) lastActivityById.set(entry.taskId, entry.ts);
  }
  return { settledById, lastActivityById };
}

/**
 * blockedBy 里**还没完工**的上游有哪些。
 * 板上查无此卡的上游(跨项目写法、或卡号写错)一律按"还没完工"算——判据不许凭"查不到"就放行:
 * 漏报一次卡住,负责人就少看见一件真该他处理的事。
 */
function unfinishedBlockers(task, index) {
  const list = (task && task.deps && task.deps.blockedBy) || [];
  const settledById = (index && index.settledById) || new Map();
  return list.filter((id) => settledById.get(id) !== true);
}

/** 真被挡住:活跃卡 + (写了阻塞理由 或 上游还没完工)。 */
function isBlocked(task, index) {
  if (!isActive(task)) return false;
  if (task.blockReason) return true;
  return unfinishedBlockers(task, index).length > 0;
}

/**
 * 阻塞已自然解除:卡上还挂着 blockedBy,但上游全完工了、也没写阻塞理由。
 * 这类卡从"阻塞"列里消失是对的,但要能单独数出来说一句,否则负责人会以为卡凭空没了。
 */
function isUnblocked(task, index) {
  if (!isActive(task) || task.blockReason) return false;
  const list = (task.deps && task.deps.blockedBy) || [];
  return list.length > 0 && unfinishedBlockers(task, index).length === 0;
}

/**
 * 这张卡最后一次"有动静"是什么时候(完整 ISO 时刻;一个线索都没有时返回 null)。
 *
 * 精确时刻有两个来源,取更新的那个:进度戳 lastProgressAt、活动流里这张卡的最后一条。
 * 只认 lastProgressAt 会把"没调 progress 但一直在提交"的卡误判成僵着。
 *
 * 【开工日只是兜底,不许参与"取最新"】dates.start 粗到天('YYYY-MM-DD'),精确时刻是完整 ISO。
 * 两种粒度丢进同一个比大小里,'2026-09-07' 会排在 '2026-09-06T20:39:45Z' 之后——今天刚开工的卡
 * 于是被判成"刚动过",真正僵着的卡反被藏起来,显示出来还是个未来时刻(0907 真机实测:dashboard 板
 * 两张施工中的卡 touched 全成了 '2026-09-07',小时数被夹成 0)。所以:有精确时刻就只用精确时刻;
 * 只剩开工日时才用它,并归一成【当地那天零点】的真时刻,好跟别的卡放在同一把尺子上比。
 */
function lastTouchedAt(task, index) {
  if (!task) return null;
  const progressTs = task.lastProgressAt || null;
  const activityTs = index && index.lastActivityById ? index.lastActivityById.get(task.id) : null;
  if (progressTs && activityTs) return progressTs > activityTs ? progressTs : activityTs;
  if (progressTs || activityTs) return progressTs || activityTs;
  const start = task.dates ? task.dates.start : null;
  if (!start) return null;
  if (String(start).indexOf('T') >= 0) return String(start);
  const localMidnight = new Date(String(start) + 'T00:00:00');
  return isNaN(localMidnight.getTime()) ? null : localMidnight.toISOString();
}

/**
 * 总览四组信号一次算完。**boards 传进来之前就该按范围筛好**(只看当前项目 / 全部项目),
 * 这里不认项目范围——范围是界面上的开关,判据不该替它做主。
 *
 * @param {Array} boards 已按范围筛过的板
 * @param {{ now?: number }} [opts] now 只为测试可复现,平时不传
 * @returns {{ blocked: Array, parked: Array, building: number, stalest: object|null }}
 */
function overviewSignal(boards, opts) {
  const now = (opts && opts.now) || Date.now();
  const blocked = [];
  const parked = [];
  let building = 0;
  let stalest = null;
  for (const board of boards || []) {
    const index = indexBoard(board);
    const projectId = (board.project && board.project.id) || '';
    const projectName = (board.project && board.project.name) || projectId;
    for (const task of board.tasks || []) {
      if (task.status === BUILDING_STATUS && isActive(task)) {
        building += 1;
        const since = lastTouchedAt(task, index);
        // 连一个时间线索都没有的卡不参与"最久没动"评比:写不出"多久",硬凑一个只会是假数字。
        if (since && (!stalest || since < stalest.since)) {
          stalest = { projectId, projectName, task, since, hours: 0 };
        }
      }
      if (isParked(task)) {
        parked.push({ projectId, projectName, task });
      } else if (isBlocked(task, index)) {
        blocked.push({ projectId, projectName, task, blockers: unfinishedBlockers(task, index) });
      }
    }
  }
  const byProjectThenId = (a, b) => a.projectName.localeCompare(b.projectName) || a.task.id.localeCompare(b.task.id);
  blocked.sort(byProjectThenId);
  parked.sort(byProjectThenId);
  if (stalest) stalest.hours = Math.max(0, Math.floor((now - Date.parse(stalest.since)) / 3600000));
  return { blocked, parked, building, stalest };
}

/**
 * 同一个 分支 / worktree / 文件域 被几张卡占着。默认只数没结案的卡:
 * 完工卡的历史分支不是抢占,把它算成冲突会让真冲突淹在几十条噪音里(审计实测 36 处冲突多为完工卡)。
 *
 * @param {Array} tasks 一块板的全部卡
 * @param {'gitBranch'|'worktree'|'fileScope'} field
 * @param {{ includeDone?: boolean, isGenerated?: (v: string) => boolean }} [opts]
 *        includeDone 打开 = 连完工卡的历史占用一起看(界面上给了开关,查历史时用);
 *        isGenerated 传 core/generatedArtifacts 的判据 —— 自动生成物谁干活都会碰,不算抢同一个文件。
 */
function occupancy(tasks, field, opts) {
  const includeDone = !!(opts && opts.includeDone);
  const isGenerated = (opts && opts.isGenerated) || function () { return false; };
  const holders = new Map();
  for (const task of tasks || []) {
    if (!includeDone && !isOccupying(task)) continue;
    const values = Array.isArray(task[field]) ? task[field] : [];
    for (const value of values) {
      if (!holders.has(value)) holders.set(value, []);
      holders.get(value).push({ id: task.id, title: task.title, plainTitle: task.plainTitle, status: task.status, settled: isSettled(task) });
    }
  }
  const rows = [];
  for (const entry of holders.entries()) {
    const generated = field === 'fileScope' && isGenerated(entry[0]) === true;
    rows.push({ v: entry[0], tasks: entry[1], conflict: entry[1].length > 1 && !generated, generated });
  }
  rows.sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.v.localeCompare(b.v));
  return rows;
}

/**
 * 这块板上有没有人登记过验收证据(测试数 / 类型检查)。
 * 一条都没有时,验收矩阵摆两列整齐的"—"只是浪费横向空间,还让人误以为"验收全挂了"。
 * tests.total 为 0 等于没填——CLI 的 `--tests 0/0/0` 写进来的是空壳。
 */
function hasAcceptanceEvidence(tasks) {
  for (const task of tasks || []) {
    if (task && task.tests && task.tests.total > 0) return true;
    if (task && task.typecheck !== undefined && task.typecheck !== null) return true;
  }
  return false;
}

/**
 * 生成给前端用的 ESM 源码(vite 虚拟模块 'virtual:task-signal' 的内容)。
 * 函数体直接取自本文件,改这里前端跟着变,不存在两份判据对不上的可能。
 */
function toEsmSource() {
  const fns = [
    isSettled, isParked, isActive, isOccupying, indexBoard, unfinishedBlockers,
    isBlocked, isUnblocked, lastTouchedAt, overviewSignal, occupancy, hasAcceptanceEvidence,
  ];
  return [
    '// 由 core/taskSignal.cjs 经 vite 虚拟模块内联生成,勿手改。',
    `export const SETTLED_STATUSES = ${JSON.stringify(SETTLED_STATUSES)}`,
    `export const PARKED_STATUS = ${JSON.stringify(PARKED_STATUS)}`,
    `export const BUILDING_STATUS = ${JSON.stringify(BUILDING_STATUS)}`,
    ...fns.map((fn) => `export const ${fn.name} = ${String(fn)}`),
    '',
  ].join('\n');
}

module.exports = {
  SETTLED_STATUSES, PARKED_STATUS, BUILDING_STATUS,
  isSettled, isParked, isActive, isOccupying,
  indexBoard, unfinishedBlockers, isBlocked, isUnblocked, lastTouchedAt,
  overviewSignal, occupancy, hasAcceptanceEvidence,
  toEsmSource,
};
