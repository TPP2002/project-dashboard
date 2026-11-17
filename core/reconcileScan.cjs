'use strict';
/**
 * reconcileScan.cjs —— 看板对账的纯判定:在办卡 × PR × 分支 × 派单器的单 → 六类「对不上」。
 * 不做任何 IO、不读时钟(只用 input.now),外部事实全由调用方喂进来。
 */

/** 六类发现(顺序即输出顺序)→ 类别人话。 */
const KINDS = {
  ALL_LANDED: '单都进主干了,卡没销',
  LANDED_NO_PR: '推了分支,没开 PR',
  AWAIT_COLLECT: '交了活,没人收',
  FORK_PENDING: '工人停在岔路,等答复',
  STALE_IN_PROGRESS: '写着施工中,多日没动静',
  CLOSED_WITH_OPEN_PR: '卡已关,PR 还开着',
};

const ACTIVE = new Set(['施工中', '待收单', '收官', '可复工', '待开工', '已拍板']);
const LANDABLE = new Set(['施工中', '待收单', '收官', '可复工']);
const CLOSED = new Set(['已完工', '暂缓', '已作废']);
const HOUR = 3600000;
const DAY = 86400000;
const RUNNING_WINDOW = 12 * HOUR;

const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const pad = (n) => String(n).padStart(2, '0');
const mmdd = (iso) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const mmddHm = (iso) => { const d = new Date(iso); return `${mmdd(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** PR 标题是否把卡号当开头(完整匹配,后随 空格 : : ( ( )或写了「(卡号)」。 */
function titleMatches(title, id) {
  const s = String(title || '');
  if (s.startsWith(id)) {
    const next = s.charAt(id.length);
    if (next === ' ' || next === ':' || next === '：' || next === '(' || next === '（') return true;
  }
  return s.includes(`(${id})`) || s.includes(`（${id}）`);
}

/** 卡的最后一次动静:lastProgressAt 与非 reconcile 作者的 activity 取最大;都没有 → null。 */
function lastTouched(task, activity) {
  let best = null;
  const take = (iso) => { const t = ms(iso); if (t !== null && (best === null || t > best.t)) best = { t, iso }; };
  take(task.lastProgressAt);
  for (const a of activity || []) {
    if (a && a.taskId === task.id && a.author !== 'reconcile') take(a.ts);
  }
  return best ? best.iso : null;
}

function scanProject(input) {
  const { projectId, board, now, staleDays, collectHours } = input;
  const exempt = input.exempt || new Set();
  const prsIn = input.prs || { available: false, open: [], merged: [] };
  const brIn = input.branches || { available: false, remote: new Map(), isAncestor: () => null };
  const jobs = input.jobs || [];
  const prsOk = !!prsIn.available;
  const brOk = !!brIn.available;
  const open = prsOk ? prsIn.open || [] : [];
  const merged = prsOk ? prsIn.merged || [] : [];
  const remote = brIn.remote || new Map();
  const ancCache = new Map();
  const isAncestor = (b) => {
    if (!brOk || typeof brIn.isAncestor !== 'function') return null;
    if (!ancCache.has(b)) ancCache.set(b, brIn.isAncestor(b));
    return ancCache.get(b);
  };
  const tasks = (board && board.tasks) || [];
  const activity = (board && board.activity) || [];
  const jobBranches = (j) => [j.branch, j.landBranch].filter(Boolean);
  const findings = [];
  const waiting = [];
  const waitingPrereq = input.waitingPrereq || new Map();
  let activeCount = 0;
  const push = (kind, task, taskKey, detail) => findings.push({
    kind, taskId: task.id, plainTitle: task.plainTitle || task.title || '', status: task.status,
    key: `${kind}:${task.id}:${taskKey}`, detail,
  });

  const mergedNums = new Set(merged.map((p) => String(p.number)));
  const anyPrHead = new Set([...open, ...merged].map((p) => p.headRefName).filter(Boolean));
  const mergedHeads = new Set(merged.map((p) => p.headRefName).filter(Boolean));

  for (const task of tasks) {
    if (!task || exempt.has(task.id)) continue;
    const id = task.id;
    const isActive = ACTIVE.has(task.status);
    if (isActive) activeCount++;
    const myJobs = jobs.filter((j) => j.taskId === id);
    const myBranches = new Set([...(task.gitBranch || []), ...myJobs.flatMap(jobBranches)]);
    const myNums = new Set((task.prNumbers || []).map(String));
    const owns = (p) => myNums.has(String(p.number)) || (p.headRefName && (
      (task.gitBranch || []).includes(p.headRefName) || myBranches.has(p.headRefName))) || titleMatches(p.title, id);
    const myOpen = open.filter(owns);
    const myMerged = merged.filter(owns);

    const inMain = (j) => jobBranches(j).some((b) => mergedHeads.has(b))
      || jobBranches(j).some((b) => isAncestor(b) === true)
      || (j.autoLandPr != null && mergedNums.has(String(j.autoLandPr)));
    const running = (j) => !!j.pid && !j.finishedAt && ms(j.startedAt) !== null
      && now - ms(j.startedAt) < RUNNING_WINDOW;
    const awaiting = (j) => !!j.finishedAt && !j.landed && !!j.worktreeExists
      && j.verdict !== 'rejected' && j.verdict !== 'blocked';
    const forked = (j) => j.verdict === 'blocked' && !!j.worktreeExists;
    const busy = myJobs.some((j) => running(j) || awaiting(j) || forked(j));
    const touched = lastTouched(task, activity);
    const touchedText = touched ? mmdd(touched) : '无记录';

    // ⑥ 卡已关,PR 还开着
    if (CLOSED.has(task.status) && prsOk) {
      for (const p of myOpen) push('CLOSED_WITH_OPEN_PR', task, String(p.number), `PR #${p.number} 还开着`);
    }
    if (!isActive) continue;

    // ① 单都进主干了,卡没销
    if (LANDABLE.has(task.status) && prsOk) {
      const dispatched = myJobs.filter((j) => j.dispatched !== false);
      const undispatched = myJobs.some((j) => j.dispatched === false);
      if ((dispatched.length > 0 || myMerged.length > 0) && dispatched.every(inMain)
        && myOpen.length === 0 && !busy && !undispatched) {
        const what = dispatched.length > 0 ? `${dispatched.length} 张单都已合进主干` : `${myMerged.length} 个 PR 已合并`;
        push('ALL_LANDED', task, '', `${what},最后一次动静 ${touchedText}`);
      }
    }

    // ②③④ 逐张单
    const seen = new Set();
    for (const j of myJobs) {
      if (seen.has(j.slug)) continue;
      seen.add(j.slug);
      if (prsOk && brOk && j.landed && j.pushed) {
        const cands = [j.landBranch, j.branch].filter(Boolean);
        const target = cands.find((b) => remote.has(b));
        if (target && isAncestor(target) !== true && !cands.some((b) => anyPrHead.has(b))) {
          push('LANDED_NO_PR', task, j.slug, `单 ${j.slug} 的分支 ${target} 推了没开 PR`);
        }
      }
      const fin = ms(j.finishedAt);
      if (fin !== null && fin < now - collectHours * HOUR && !j.landed && j.worktreeExists
        && j.verdict !== 'rejected' && j.verdict !== 'blocked') {
        push('AWAIT_COLLECT', task, j.slug, `单 ${j.slug} ${mmddHm(j.finishedAt)} 交活,到现在没人收`);
      }
      if (j.verdict === 'blocked' && j.worktreeExists) {
        const at = j.finishedAt || j.startedAt;
        const t = ms(at);
        if (t !== null && t < now - collectHours * HOUR) {
          push('FORK_PENDING', task, j.slug, `单 ${j.slug} ${mmddHm(at)} 停在岔路,到现在没人答复`);
        }
      }
    }

    // ⑤ 写着施工中,多日没动静
    if (task.status === '施工中') {
      const tt = touched === null ? null : ms(touched);
      const stale = tt === null || tt < now - staleDays * DAY;
      const freshBranch = (task.gitBranch || []).some((b) => {
        const t = ms(remote.get(b));
        return t !== null && t > now - staleDays * DAY;
      });
      if (stale && myOpen.length === 0 && !busy && !freshBranch) {
        const entries = waitingPrereq.get(task.id);
        if (Array.isArray(entries) && entries.length) {
          const n = entries.length;
          const list = entries.slice(0, 3).map((entry) => `${entry.slug}(${entry.reasons[0] || '没写原因'})`).join(';');
          waiting.push({ taskId: task.id, plainTitle: task.plainTitle || task.title || '', status: task.status,
            detail: `${n} 份契约在等前置:${list}${n > 3 ? `;等 ${n} 份` : ''}` });
        } else {
          const days = tt === null ? null : Math.floor((now - tt) / DAY);
          push('STALE_IN_PROGRESS', task, '',
            `${days === null ? '一直' : days + ' 天'}没有动静,没有开着的 PR、在跑的单,分支也没有新提交`);
        }
      }
    }
  }

  const order = Object.keys(KINDS);
  findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { projectId, findings, activeCount, waiting };
}

module.exports = { scanProject, KINDS, lastTouched, titleMatches };
