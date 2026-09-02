'use strict';

/**
 * 可并行任务清单 —— 回答一个具体问题:**现在这些卡里,哪几张可以同时派给不同对话去做?**
 *
 * 【为什么要有它】负责人不看代码,不可能知道哪张卡会动哪个文件、跟谁冲突。
 * 他原话:「我之前派发并行任务都得每次新开对话,基于当前情况进行梳理,然后再派发,
 * 这一轮派发结束后,又得新开对话,重新梳理」——每轮都要烧一次额度重算同一件事。
 *
 * 【为什么不用 AI 算】这里全是规则判断,数据看板本来就有:
 * 依赖关系、施工状态、分支占用、文件范围。纯计算,零额度,而且卡片一变就自动重算。
 *
 * 【判断顺序】硬排除在前(有人做了/被挡住),软分组在后(可能撞车):
 *   1. 状态不是「未开工 / 已拍板」的 → 不在候选里(施工中的已被人占)
 *   2. 上游依赖未完工 → 挡住,列出挡它的是谁
 *   3. 文件范围重叠 → 归为一组,组内只推一张,其余标「等这组当前那张」
 *   4. 没填文件范围的 → 退回按卡号前缀分组,并明确标注这是**猜的**
 */

/** 可以被派出去的状态。「待拍板」不在内——那得先拍板。 */
const DISPATCHABLE = new Set(['未开工', '已拍板']);
/** 视为"已经完成、不再阻塞下游"的状态。 */
const SETTLED = new Set(['已完工']);

/** 卡号前缀:取第一段(CLUSTER-DISPATCH-XXX → CLUSTER)。只用于没填文件范围时的兜底分组。 */
function idPrefix(id) {
  const s = String(id || '');
  const cut = s.indexOf('-');
  return cut > 0 ? s.slice(0, cut) : s;
}

/**
 * 把 glob 归一成"用于判重叠的目录键"。
 * 比对的是**目录层级**而不是精确文件:两张卡都在 src/engine/market/ 下就算可能撞,
 * 宁可保守——误判成撞车的代价(少派一张)远小于漏判(两个人改同一个文件)。
 */
function scopeKeys(fileScope) {
  if (!Array.isArray(fileScope)) return [];
  const keys = new Set();
  for (const raw of fileScope) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    // 统一分隔符、砍掉通配段与花括号枚举,只留前面的稳定目录部分
    const normalized = raw.trim().replace(/\\/g, '/').replace(/\{[^}]*\}/g, '');
    const segments = normalized.split('/').filter(Boolean);
    const stable = [];
    for (const seg of segments) {
      if (seg.includes('*') || seg.includes('?')) break;
      stable.push(seg);
    }
    // 取到两层就够:再深会让"同模块不同文件"被判成不撞,反而放过真冲突
    if (stable.length) keys.add(stable.slice(0, 2).join('/'));
  }
  return [...keys];
}

/** 两张卡的文件范围有没有交集。 */
function overlaps(a, b) {
  if (!a.length || !b.length) return false;
  return a.some((key) => b.some((other) => key === other || key.startsWith(other + '/') || other.startsWith(key + '/')));
}

/**
 * 算出并行清单。
 * @param {Array} tasks 看板 tasks 数组(原样传入)
 * @returns {{ready:Array, blocked:Array, running:Array, stats:object}}
 */
function buildParallelPlan(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(list.map((t) => [t.id, t]));

  const running = [];
  const blocked = [];
  const candidates = [];

  for (const task of list) {
    const status = task.status;
    if (status === '施工中') {
      running.push({
        id: task.id,
        plainTitle: task.plainTitle || null,
        title: task.title || '',
        branches: Array.isArray(task.gitBranch) ? task.gitBranch : [],
      });
      continue;
    }
    if (!DISPATCHABLE.has(status)) continue;

    // 上游没完工 = 现在开工也白干
    const deps = task.deps || {};
    const upstream = [
      ...(Array.isArray(deps.dependsOn) ? deps.dependsOn : []),
      ...(Array.isArray(deps.blockedBy) ? deps.blockedBy : []),
    ];
    const unmet = upstream.filter((id) => {
      const up = byId.get(id);
      return up ? !SETTLED.has(up.status) : false; // 查不到的卡号不当作阻塞,避免历史脏数据把卡永久挡死
    });
    if (unmet.length) {
      blocked.push({
        id: task.id,
        plainTitle: task.plainTitle || null,
        title: task.title || '',
        waitingFor: unmet.map((id) => ({ id, title: byId.get(id)?.plainTitle || byId.get(id)?.title || '' })),
      });
      continue;
    }

    const keys = scopeKeys(task.fileScope);
    candidates.push({
      id: task.id,
      plainTitle: task.plainTitle || null,
      title: task.title || '',
      modelHint: task.modelHint || null,
      percent: typeof task.percent === 'number' ? task.percent : 0,
      scopeKeys: keys,
      hasScope: keys.length > 0,
      prefix: idPrefix(task.id),
    });
  }

  // 施工中的卡也参与占位:它正在改的文件,别再派第二张进去
  const runningKeys = [];
  for (const task of list) {
    if (task.status !== '施工中') continue;
    const keys = scopeKeys(task.fileScope);
    if (keys.length) runningKeys.push({ id: task.id, keys });
  }

  // 分组:有文件范围的按范围重叠,没有的按卡号前缀(并标注为猜测)
  const groups = [];
  for (const card of candidates) {
    let joined = null;
    for (const group of groups) {
      const sameScope = card.hasScope && group.hasScope && overlaps(card.scopeKeys, group.keys);
      const samePrefix = !card.hasScope && !group.hasScope && group.prefix === card.prefix;
      if (sameScope || samePrefix) { joined = group; break; }
    }
    if (joined) {
      joined.members.push(card);
      for (const key of card.scopeKeys) if (!joined.keys.includes(key)) joined.keys.push(key);
    } else {
      groups.push({
        prefix: card.prefix,
        hasScope: card.hasScope,
        keys: [...card.scopeKeys],
        members: [card],
      });
    }
  }

  const ready = [];
  const waitingSameArea = [];
  for (const group of groups) {
    // 这一组的文件正被某张施工中的卡占着 → 整组先别派
    const occupiedBy = group.hasScope
      ? runningKeys.find((r) => overlaps(group.keys, r.keys))
      : null;
    const sorted = [...group.members].sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
    if (occupiedBy) {
      for (const member of sorted) {
        waitingSameArea.push({ ...member, reason: 'occupied', blockerId: occupiedBy.id });
      }
      continue;
    }
    const [first, ...rest] = sorted;
    ready.push({ ...first, groupSize: group.members.length, guessedGroup: !group.hasScope });
    for (const member of rest) {
      waitingSameArea.push({ ...member, reason: 'same-area', blockerId: first.id, guessed: !group.hasScope });
    }
  }

  ready.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ready,
    waitingSameArea,
    blocked,
    running,
    stats: {
      readyCount: ready.length,
      sameAreaCount: waitingSameArea.length,
      blockedCount: blocked.length,
      runningCount: running.length,
      withScope: candidates.filter((c) => c.hasScope).length,
      candidates: candidates.length,
    },
  };
}

module.exports = { buildParallelPlan, scopeKeys, overlaps, idPrefix };
