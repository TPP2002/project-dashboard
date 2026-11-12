'use strict';
/**
 * 看板服务自动按月归档旧活动。
 *
 * 分层约束：server/ 与 core/ 不许 require cli/（cli → core 单向）。
 * 所以服务端不直接调 archiveActivity，而是经本模块起子进程跑 cli 的
 * `archive-activity` 命令行入口，复用它的 store.mutate 锁 + 原子写 + 归档文件格式。
 *
 * 行为口径（定死，见施工单）：
 *   - 启动后 initialDelayMs 跑一次，之后每 intervalMs 跑一次；
 *   - runOnce 对 listProjects() 返回的项目依次（不并发）spawnArchive(id, before)；
 *   - before = 上一个月（本地时间）；保留本月与上月，更早的活动被归档；
 *   - moved>0 才 log 一行；抛错时 warn 一行，同一项目同一错误文案连续出现不重复 warn；
 *   - 上一轮未完成时到点不叠加（跳过并计数）；
 *   - 定时器 unref，stop() 清定时器，服务关闭时调用 stop()。
 */
function createActivityAutoArchive({
  listProjects,
  spawnArchive,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  initialDelayMs = 60000,
  intervalMs = 86400000,
  log = console.log,
  warn = console.warn,
}) {
  if (typeof listProjects !== 'function') throw new Error('createActivityAutoArchive: 必须提供 listProjects');
  if (typeof spawnArchive !== 'function') throw new Error('createActivityAutoArchive: 必须提供 spawnArchive');

  let timer = null;
  let active = false;
  let running = false;
  let skipped = 0;
  // 每个项目最近一次告警的错误文案；成功或换文案才重新告警（"连续出现不重复刷屏"）。
  const lastErrorByProject = new Map();

  /** 取 date 本地时间的上个月，返回 'YYYY-MM'；1 月退到上一年 12 月。 */
  function beforeMonth(date) {
    const year = date.getFullYear();
    const monthIndex = date.getMonth(); // 0-based
    if (monthIndex === 0) return `${year - 1}-12`;
    return `${year}-${String(monthIndex).padStart(2, '0')}`;
  }

  async function runOnce() {
    const before = beforeMonth(new Date(now()));
    const ids = listProjects();
    for (const id of ids) {
      try {
        const res = await spawnArchive(id, before);
        if (res && res.moved > 0) log(`[activity-archive] 项目 ${id} 归档 ${res.moved} 条`);
        lastErrorByProject.delete(id); // 成功打断错误连续，下次失败仍告警
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        if (lastErrorByProject.get(id) === message) {
          // 同一项目同一错误文案连续出现：不重复刷屏。
        } else {
          lastErrorByProject.set(id, message);
          warn(`[activity-archive] 项目 ${id} 归档失败：${message}`);
        }
      }
    }
  }

  async function tick() {
    if (!active) return;
    // 先排下一轮，保证无论本轮是跳过还是执行，链条都不中断（避免一轮卡死就永久停摆）。
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (running) { skipped++; return; } // 上一轮没跑完：不叠加
    running = true;
    try { await runOnce(); }
    finally { running = false; }
  }

  function start() {
    if (active) return;
    active = true;
    timer = setTimer(tick, initialDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    active = false;
    if (timer) { clearTimer(timer); timer = null; }
  }

  return { start, stop, runOnce, beforeMonth };
}

module.exports = { createActivityAutoArchive };
