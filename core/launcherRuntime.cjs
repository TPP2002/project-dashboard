'use strict';
/**
 * launcherRuntime.cjs —— 启动器侧的常驻服务生命周期（DASH-LAUNCHER-NO-SCHED-HOLD-1012 阶段 2）。
 *
 * 【这份文件管什么】只管启动器【自己】的常驻服务：归属登记、经真实 hold 的包装启动、
 * 授予后的账/进程一致（看护）、以及只对自己子树的停止。编排（安装依赖、发布构建、模式选择）
 * 在 cli/launcher.cjs；启动看板.bat / dashboard.sh 只是薄入口。共享盘客户端（sched.cjs）
 * 一字不改、不重写、不伪造许可；调度策略照旧。
 *
 * 【病根（诊断报告 launcher-hold-diagnosis-1014.md 已实证）】
 *   · 现行 hold 授予后只等子进程、不监听票态：正式 cancel 一张在跑的 hold 单后，票据 = cancelled
 *     而 wrapper/server 仍活 —— 账与进程脱节必须由【启动器侧】对齐（看护），不改客户端核心；
 *   · 同版本重复双击只许复用【本启动器已登记且归属/票态验证通过】的实例，绝不凭 PID 单独假定归属，
 *     未知或不归本启动器的实例明确拒绝接管，不杀、不冒充；
 *   · 幂等键每次实际生命周期唯一（客户端对已终态票不能按同一键再登记，固定键会让"停了再启"卡死）。
 *
 * 【分层】本文件不 require cli/（cli → core 单向）。探活 /api/health 复用 cli/release.cjs 的
 * serviceStatus，由 cli/launcher.cjs 探好把结果传进来；本文件只做纯判定与进程生命周期。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');
const { withLock } = require('./lock.cjs');
const { DASHBOARD_HOME } = require('./resolveProject.cjs');

/** 归属登记的 schema 版本；字段或判据变了就升版本，旧记录一律按"登记失效"处理（宁拒接不冒充）。 */
const RECORD_SCHEMA = 1;
/** 归属登记落在看板既有数据根（DASHBOARD_HOME，与 registry/snapshots 同域），不另造数据域。 */
const RECORD_NAME = 'launcher-instance.json';
/**
 * 常驻服务只申请 1 核。实据（诊断报告 §3，主控正式 hold 实测）：空闲窗口均值 0.0182 核、
 * 单轮三个只读 API 窗口均值 0.904 核；hold 最小合法正整数 1 —— max(⌈0.904⌉, 1) = 1。
 * hold 是记账不是限流：1 核是账面占用数，server 不消费该值、没有任何核数上限生效。
 */
const RESIDENT_CORES = 1;
/** 票据终态口径，与 core/scheduledWork.cjs 逐字一致。 */
const TERMINAL_STATES = ['passed', 'failed', 'cancelled', 'voided'];
/** 看护轮询间隔缺省 10 秒。 */
const DEFAULT_WATCH_INTERVAL_MS = 10000;
/**
 * 调度台持续不可读的停止预算，缺省 60 秒。依据：包装进程活着时客户端每 30 秒一拍续约，共享盘
 * 持续故障会写不进去；派单员按"断租超时"销单的缺省门槛是 120 秒（USAGE 所载，派单员侧本仓
 * 不可审计）。须计入上次续约最多已过 30 秒、下一次看护最多 10 秒；60 秒读失败预算
 * 在 120 秒窗口内还为正常停止留下 20 秒余量，不能仅以“90 < 120”忽略既有租约年龄：
 * 先停自有进程、再退单，账还在我们手里时就收场 —— 不许变成"账被回收、进程还无登记在跑"。
 */
const DEFAULT_SHARE_FAIL_BUDGET_MS = 60000;

/** 看护间隔/停止预算可用环境变量覆盖（测试与隔离专用；生产不设即用缺省）。 */
const ENV_WATCH_INTERVAL = 'DASHBOARD_LAUNCHER_WATCH_INTERVAL_MS';
const ENV_SHARE_FAIL_BUDGET = 'DASHBOARD_LAUNCHER_WATCH_SHARE_FAIL_BUDGET_MS';

function envNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ——————— 归属登记（本启动器起过的实例的唯一凭据） ———————

/** 归属登记文件路径；home 缺省 = 看板数据根（测试可传临时目录隔离）。 */
function recordPath(home = DASHBOARD_HOME) {
  return path.join(home, RECORD_NAME);
}

/** 读归属登记；缺文件/坏 JSON 一律 null（调用方按"没有登记"处理，绝不猜）。 */
function readRecord(file = recordPath()) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch { return null; }
}

/**
 * 原子写归属登记 —— 【裸原语】：只保证不写坏 JSON，不保证不丢逻辑更新。
 * 生产写一律走下面带锁的协议入口（writeRecordLocked / updateOwnRecordLocked），
 * 绝不在裸原语与带锁入口之间嵌套同一把锁。
 */
function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJsonSync(file, record);
  return record;
}

/**
 * 读-改-写归属登记 —— 【裸原语】，读与写之间没有跨进程临界区（TOCTOU）。
 * 只留给测试/工具直用；生产的读改写走 updateOwnRecordLocked（锁内重读+核 key）。
 * fn 返回【同一个对象引用】= 判定"这拍不写"。
 */
function updateRecord(file, fn) {
  const before = readRecord(file);
  const after = fn(before);
  if (after === before) return before;
  return writeRecord(file, after);
}

/**
 * 登记写锁：与登记同目录同名 + `.write.lock`（R9 实证 tk-37706b11 后引入）。
 * 复用 core/lock.cjs 的 withLock，不改锁库；与启动编排锁（`<登记>.lock`）是两把锁，
 * 绝不共用也绝不嵌套 —— 编排锁盖"探活→发布→挂号起服务"，写锁只盖登记的读改写这一瞬。
 */
function recordWriteLockPath(file) {
  return `${file}.write.lock`;
}

/**
 * 新生命周期落盘（启动器接主登记）：同一把写锁的短临界区。不核 key —— 启动编排锁在手，
 * 本次生命周期就是要接主登记；锁保证它与旧看护的在途回写一个完成了再轮到另一个，
 * 谁后写谁生效，绝无"旧读整篇盖掉新生命周期"的交错。
 */
function writeRecordLocked(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });   // 锁文件与登记同目录，先保证在
  return withLock(recordWriteLockPath(file), () => writeRecord(file, record));
}

/**
 * 归属登记的读-核 key-改-写【一个短跨进程临界区】（R9 实证 tk-37706b11：旧看护的退出回写
 * 拿进锁前读到的旧生命周期整篇，把刚接主的新生命周期盖了回去 —— 原子改名只防写坏 JSON，
 * 防不了丢逻辑更新）。协议：withLock 进临界区 → 【锁内重读】→ key 与 expectedKey 不符
 * =【真正零写入】（连写盘的机会都不给，别人刚补的字段一个不丢）→ 改 → 原子写。
 * 所有写者（启动器接主、看护补记/回写）同走此协议；绝不嵌套同一把锁。
 */
function updateOwnRecordLocked(file, expectedKey, fn, { err = () => {} } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });   // 锁文件与登记同目录，先保证在
  return withLock(recordWriteLockPath(file), () => {
    const before = readRecord(file);
    if (expectedKey && before && before.key && before.key !== expectedKey) {
      err(`[launcher-record] 归属登记已属于另一个生命周期（登记 key ${before.key} ≠ 本次 ${expectedKey}），不拼改、不覆盖、零写入。`);
      return before;
    }
    const after = fn(before);
    if (after === before) return before;
    return writeRecord(file, after);
  });
}

/**
 * 起服前的归属确认（R9）：在登记写锁的短临界区内重读并核对 key/票号/包装进程。
 * 登记不存在、已换主、票号或包装进程对不上 = 不是本次生命周期的登记 ——
 * 看护绝不为它起服务（M1 实证的"先 spawn 无登记服务、再拒写登记"就是这条缝）。
 * 只读不写：真正落 serverPid 在 spawn 之后由 updateOwnRecordLocked 补。
 */
function confirmOwnRecordLocked(file, { key, ticketId = null, wrapperPid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });   // 锁文件与登记同目录，先保证在
  return withLock(recordWriteLockPath(file), () => {
    const r = readRecord(file);
    if (!r) return { ok: false, reason: '归属登记不存在 —— 本生命周期还没有可核验的登记' };
    if (!key || r.key !== key) {
      return { ok: false, reason: `归属登记已属于另一个生命周期（登记 key ${r.key ?? '无'} ≠ 本看护 ${key ?? '无'}）` };
    }
    if (ticketId && r.ticketId !== ticketId) {
      return { ok: false, reason: `归属登记的票号与本单不符（登记 ${r.ticketId ?? '无'} ≠ 本单 ${ticketId}）` };
    }
    if (r.wrapperPid !== wrapperPid) {
      return { ok: false, reason: `归属登记的包装进程与本看护不符（登记 ${r.wrapperPid ?? '无'} ≠ ${wrapperPid}）` };
    }
    return { ok: true, record: r };
  });
}

/**
 * 登记是否是一份【本机、完整、可核验】的归属记录。任何一条不满足都返回 null ——
 * 归属判定宁可拒接也不猜测；这里只验形状，票态核验在 classifyInstance。
 */
function validRecord(record, hostname = os.hostname()) {
  if (!record || record.schema !== RECORD_SCHEMA) return null;
  if (record.hostname !== hostname) return null;
  if (record.mode !== 'strict' && record.mode !== 'standalone') return null;
  if (!Number.isInteger(record.serverPid) || record.serverPid <= 0) return null;
  if (record.mode === 'strict'
    && (typeof record.ticketId !== 'string' || !record.ticketId
      || typeof record.title !== 'string' || !record.title)) return null;
  return record;
}

/**
 * 幂等键：每次【实际生命周期】唯一（宿 + 时间戳 + 随机），不用永久固定键。
 * 终态后能再次起：停了再启会拿到全新键 → 全新单号；同一次运行内的重复挂号仍被客户端幂等吸收。
 * 防"重复双击起两份"靠探活与归属判定，不靠键。
 */
function newLifecycleKey(prefix, { hostname = os.hostname(), now = new Date(), random = Math.random } = {}) {
  const host = String(hostname).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 16) || 'host';
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = Math.floor(random() * 46656).toString(36).padStart(3, '0')
    + Math.floor(random() * 46656).toString(36).padStart(3, '0');
  // 总长 ≤ 40，落在共享盘 SAFE_SEGMENT（[A-Za-z0-9._-]）内
  return `${prefix}-${host}-${stamp}-${rand}`;
}

/** 常驻单标题：进票据也进归属登记，票态核验时比对（票据在不在、是不是我们那一单）。 */
function residentTitle(hostname = os.hostname()) {
  return `看板常驻服务 @${hostname}`;
}

// ——————— 在跑实例的归属判定（探活 + 归属登记 + 票态，三重核验） ———————

function refuseUnknownReason(record, health) {
  const base = `端口 ${health.port} 上有看板服务在跑（pid ${health.pid}，` +
    (health.releaseCommit ? `发布副本 @ ${String(health.releaseCommit).slice(0, 12)}` : (health.mode || '版本未知')) + '），' +
    '但它不是本启动器当前有效登记的实例';
  if (!record) {
    return base + '（没有归属登记）。旧版启动器直起的实例不归本启动器管：绝不冒充登记、不接管、不杀。' +
      `请先关掉它的窗口（或自行结束进程 ${health.pid}），再双击启动器。`;
  }
  return base + '（登记已失效：schema/主机名/进程号对不上）。请先自行确认并关掉它，再双击启动器。';
}

/**
 * 归属判定。只依据三样东西，绝不凭 PID 单独假定归属：
 *   ① 探活：/api/health 有没有在跑的实例；
 *   ② 归属登记：本机数据根里有没有一条 schema/主机/进程号都对得上的记录；
 *   ③ 票态核验：严格模式实例还要求它的调度单非终态、标题与登记一致。
 * 健康未响应时，另用登记 PID 的存活查询保守阻止重复启动；这不构成归属证明。
 * 返回 {kind, ...}：
 *   none          —— 没有实例，正常走启动；
 *   reuse         —— 本启动器登记的同版本实例，复用即可（不重复挂号、不重复长期占核）；
 *   reuse-old     —— 本启动器登记的旧版本实例 + DASHBOARD_NO_RESTART=1：复用旧实例并明说仍是旧版；
 *   restart-own-old—— 本启动器登记的旧版本实例：按既有换新语义退旧单、停旧进程、再起新单；
 *   refuse        —— 健康未响应但登记进程可能仍活 / 未知归属 / 跨模式 / 票态核验失败：明确拒绝接管，一个进程都不动。
 */
function classifyInstance({
  health, record, launcherMode, client = null, share = null,
  hostname = os.hostname(), stamp = null, releaseRoot = null, noRestart = false,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  if (!health) {
    const rec = validRecord(record, hostname);
    // PID 仅用于保守阻止重复启动，不能证明归属、授权复用或退旧。
    if (rec && pidAlive(rec.serverPid, kill)) {
      return { kind: 'refuse', reason: `健康检查未响应，但本机登记进程（pid ${rec.serverPid}）仍活着或无法确认已退出。` +
        '本次拒绝新启动，不复用、不换版、不覆盖归属登记，也不停止进程；请稍后重试或检查现有服务。' };
    }
    return { kind: 'none' };
  }
  if (health.mode === 'dev') {
    return { kind: 'refuse', reason: `端口 ${health.port} 上是【开发实例】（pid ${health.pid}，代码根 ${health.codeRoot}）。` +
      '启动器不接管开发实例 —— 负责人日常用的看板该从发布副本起。请先关掉它再双击启动器。' };
  }
  const rec = validRecord(record, hostname);
  if (!rec) return { kind: 'refuse', reason: refuseUnknownReason(record, health) };
  if (rec.serverPid !== health.pid) {
    return { kind: 'refuse', reason: `端口 ${health.port} 上的服务（pid ${health.pid}）不是本启动器登记的进程（登记的是 pid ${rec.serverPid}）。` +
      `不确定归属就不接管：请先自行确认并关闭它，再双击启动器。` };
  }
  if (rec.mode !== launcherMode) {
    return { kind: 'refuse', reason: rec.mode === 'strict'
      ? `在跑的实例（pid ${health.pid}）是本启动器以严格模式登记的（调度单 ${rec.ticketId}），独立模式无法核验其票据，不接管。` +
        `请关闭它的窗口（或结束进程 ${health.pid}）后再启动。`
      : `在跑的实例（pid ${health.pid}）是本启动器以独立模式起的（无调度票据），严格模式要求票据核验，不接管。` +
        `请关闭它的窗口（或结束进程 ${health.pid}）后再启动；确要继续独立运行，加 --standalone。` };
  }
  if (rec.mode === 'strict') {
    if (!client || !share) {
      return { kind: 'refuse', reason: `在跑的实例（pid ${health.pid}）是严格模式登记的，票据核验需要调度客户端，但它现在不可用。` +
        '不降级、不接管：修好共享盘后重试。' };
    }
    let st = null;
    try { st = client.status(rec.ticketId, { share }); }
    catch (e) {
      return { kind: 'refuse', reason: `本启动器登记的实例（pid ${health.pid}）票据核验失败：${e.message}。不冒充、不接管。` };
    }
    if (!st || TERMINAL_STATES.includes(st.state)) {
      return { kind: 'refuse', reason: `本启动器登记的实例（pid ${health.pid}）调度票据已终态（${st ? st.state : '读不到'}）而服务还在跑 —— 账与进程已脱节。` +
        `请关闭它的窗口（或结束进程 ${health.pid}），再双击启动器。` };
    }
    if (st.title !== undefined && st.title !== null && st.title !== rec.title) {
      return { kind: 'refuse', reason: `登记票据 ${rec.ticketId} 的标题与登记记录不符，归属存疑，不接管。` };
    }
  }
  // 同版本：健康上报的代码根/提交 与【这次要起的发布副本】一致（与 server 的 isSameRuntime 同口径）。
  const sameVersion = !!stamp && !!releaseRoot
    && health.releaseCommit === stamp.commit
    && health.codeRoot !== undefined && path.resolve(health.codeRoot) === path.resolve(releaseRoot);
  if (sameVersion) return { kind: 'reuse', health, record: rec };
  if (noRestart) return { kind: 'reuse-old', health, record: rec };
  return { kind: 'restart-own-old', health, record: rec };
}

/**
 * 退掉【本启动器自己登记且归属核验通过】的旧实例：先尽力撤自己的调度单，再停自己的进程树，
 * 并确认树真的退了。撤单失败不拦换新：服务一停、续约一断，派单员按断租超时兜底销单（晚一拍
 * 释放，不是丢账）。但【停进程】必须确认完成 —— 没退干净就返回 ok:false，调用方不得另起新单。
 * 绝不用于任何未通过归属核验的实例。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function retireOwnInstance({
  record, client = null, share = null, stopTree: stop = stopTree,
  log = console.log, platform = process.platform,
} = {}) {
  if (!record) return { ok: true };
  if (record.ticketId && client && share) {
    try {
      const r = await client.cancel(record.ticketId, { share, reason: '启动器换新：旧版本常驻服务退场' });
      if (r && r.exitCode) log(`旧调度单 ${record.ticketId} 撤单未确认（退出码 ${r.exitCode}）；旧服务停止后由派单员按断租超时兜底销单。`);
      else log(`已撤旧调度单 ${record.ticketId}。`);
    } catch (e) {
      log(`旧调度单 ${record.ticketId} 撤单失败：${e.message}；旧服务停止后由派单员按断租超时兜底销单。`);
    }
  }
  const r = await stop(record.serverPid, { platform });
  if (r && r.ok) {
    log(`已停止旧实例进程树（pid ${record.serverPid}）。`);
    return { ok: true };
  }
  const reason = `旧实例进程树（pid ${record.serverPid}）停止未确认（${(r && r.reason) || '未知原因'}）`;
  log(`✖ ${reason}。不冒充已退场：本次不另起新单，请人工确认并结束该进程后重试。`);
  return { ok: false, reason };
}

// ——————— 停止自己的子树 ———————

/**
 * 停一棵【已通过归属核验】的进程树，并【确认它真的退了】才算 ok。调用方只许拿它停自己
 * spawn 出来的子树；绝不做"按进程名扫 node 全杀"那类事。
 * Windows：taskkill /T /F 整树强杀（只杀父进程会留下孙进程——任务单红线）→ 有界异步等确认退出；
 * 其余平台：SIGTERM → 有界异步等（不忙等占核）→ SIGKILL → 再有界异步等；等不到就如实报败，
 * 由调用方决定怎么兜底 —— 绝不把"发了信号"冒充成"已停止"。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function stopTree(pid, { platform = process.platform, spawnSync = cp.spawnSync, kill = (p, s) => process.kill(p, s), graceMs = 3000, delayMs = 50 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return { ok: false, reason: `pid 不合法：${pid}` };
  const gone = () => {
    try { kill(p, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
  };
  if (platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(p), '/T', '/F'], { windowsHide: true });
    if (r.error) return { ok: false, reason: r.error.message };
    if (r.status !== 0) {
      const text = String((r.stderr && r.stderr.toString()) || (r.stdout && r.stdout.toString()) || `taskkill 退出码 ${r.status}`).trim();
      return { ok: false, reason: text.split('\n')[0] || `taskkill 退出码 ${r.status}` };
    }
    const deadline = Date.now() + graceMs;
    while (!gone()) {
      if (Date.now() >= deadline) return { ok: false, reason: `taskkill 已下发但 ${graceMs}ms 内未见进程 ${p} 退出` };
      await sleep(delayMs);
    }
    return { ok: true };
  }
  try { kill(p, 'SIGTERM'); } catch (e) {
    if (e && e.code === 'ESRCH') return { ok: true };
    return { ok: false, reason: e.message };
  }
  const deadline = Date.now() + graceMs;
  while (!gone()) {
    if (Date.now() >= deadline) break;
    await sleep(delayMs);
  }
  if (!gone()) {
    try { kill(p, 'SIGKILL'); } catch (e) {
      if (e.code !== 'ESRCH') return { ok: false, reason: e.message };
      return { ok: true };
    }
    const killDeadline = Date.now() + graceMs;
    while (!gone()) {
      if (Date.now() >= killDeadline) return { ok: false, reason: `SIGKILL 已下发但 ${graceMs}ms 内未见进程 ${p} 退出` };
      await sleep(delayMs);
    }
  }
  return { ok: true };
}

/** 进程还活着吗。查询失败（权限等）按"活着"处理：归属不明时绝不冒进。 */
function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

// ——————— 启动互斥（防"两个启动器同时探到 none → 各挂一张长期单"） ———————

/**
 * 启动互斥锁：数据域里锁文件的【独占创建】（O_EXCL），最小实现、不是通用锁框架 ——
 * 只护启动器"探活→归属判定→挂号→起服务"这一段，防止并发双击各写各的登记、各挂一张 hold。
 * 持锁者把 pid 写进锁文件：持锁进程还活着就不抢（第二个启动器得到明确"已有编排/复用"结果）；
 * 进程已死 → 陈锁，清掉重试（有界）。
 * 【绝不偷活锁】：锁文件存在但内容还读不出来（持锁者刚独占创建、pid 还没落盘的窗口）＝
 * 有人正拿着锁 —— 按"有人持锁"处理，**绝不当作陈锁去删**（真多进程竞态实测：删了就会两个都持锁）；
 * 只有内容坏了【且文件够老】（超过 STALE_MS，说明是崩在半路的残骸）才按陈锁清理。
 * 锁有效性不依赖文件句柄（跨进程只认 pid），因此天然能横跨 async await 的整段启动过程；
 * 正常收尾由持锁者 release，被杀则下次按陈锁清理。
 *
 * @returns {{file: string, release: () => void} | null} null = 已有活的启动器持锁
 */
const MUTEX_STALE_MS = 30000;
function acquireLaunchMutex(file, { kill = (p, s) => process.kill(p, s), attempts = 3, staleMs = MUTEX_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < attempts; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
      finally { fs.closeSync(fd); }
      return {
        file,
        release() { try { fs.unlinkSync(file); } catch { /* 删不掉留给陈锁路径；不影响进程退出 */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 读不了：可能是正写着，也可能是残骸 */ }
      if (holder && Number.isInteger(holder.pid)) {
        if (pidAlive(holder.pid, kill)) return null;
        try { fs.unlinkSync(file); } catch { /* 抢不掉下轮再试 */ }
        continue;
      }
      // 内容读不出：够老才当残骸清；还新就是持锁者正在写，宁可让第二个启动器拿到"已在启动中"
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* 文件刚被别人删了：下轮重试 */ }
      if (age >= staleMs) {
        try { fs.unlinkSync(file); } catch { /* 抢不掉下轮再试 */ }
      } else {
        return null;   // 有人正在启动 —— 明确不抢
      }
    }
  }
  return null;
}

/** SCHED_PERMIT 的票号段（格式口径与共享盘客户端逐字一致）：只取出来和登记票号比对，语义核验在 verifyResidentGrant。 */
function permitTicketId(encoded) {
  if (typeof encoded !== 'string') return null;
  const m = /^(tk-[0-9a-f]{20}):(a[1-9]\d*):/.exec(encoded);
  return m ? m[1] : null;
}

// ——————— 看护进程（hold / 直起的 wrapper 与 server 之间的一层） ———————

/**
 * 看护进程的 argv。全部走【绝对路径 + Node argv 数组】，不经 shell 拼串：
 * 严格模式下它由真实 hold 作为命令拉起（cwd=检出，EBUSY 纪律），独立模式下由启动器直拉。
 * `--key` 是本次生命周期幂等键：看护对归属登记做任何读改写前先核对，登记已换主就绝不拼改。
 * `--` 之后的参数原样转交给 server。
 */
function watcherArgv({ runtimePath, ticketId = null, share = null, wrapperPid, recordFile, serverPath, serverArgs = [], key = null }) {
  const args = [
    path.resolve(runtimePath), '--watch-server',
    '--wrapper', String(wrapperPid),
    '--record', path.resolve(recordFile),
    '--server', path.resolve(serverPath),
  ];
  if (ticketId) args.push('--ticket', String(ticketId));
  if (share) args.push('--share', path.resolve(share));
  if (key) args.push('--key', String(key));
  args.push('--', ...serverArgs);
  return args;
}

/** 解析看护进程自己的 argv；`--` 之后是 server 参数。键名与 runWatchServer 的入参一致，CLI 入口原样透传。 */
function parseWatchArgs(argv = []) {
  const out = { ticketId: null, share: null, wrapperPid: null, record: null, server: null, serverArgs: [], key: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.serverArgs = argv.slice(i + 1); break; }
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`缺少参数：${a}`);
      i += 1;
      return v;
    };
    if (a === '--ticket') out.ticketId = val();
    else if (a === '--share') out.share = val();
    else if (a === '--wrapper') out.wrapperPid = Number(val());
    else if (a === '--record') out.record = val();
    else if (a === '--server') out.server = val();
    else if (a === '--key') out.key = val();
    else throw new Error(`看护进程不认识的参数：${a}`);
  }
  if (!out.server) throw new Error('缺少 --server <server.cjs 绝对路径>');
  if (!out.record) throw new Error('缺少 --record <归属登记文件绝对路径>');
  if (!Number.isInteger(out.wrapperPid) || out.wrapperPid <= 0) throw new Error('缺少或非法 --wrapper <包装进程 pid>');
  if (out.ticketId && !out.share) throw new Error('--ticket 必须与 --share 成对给出');
  return out;
}

/** 看护进程用的调度客户端：只加载真实共享盘客户端，不重写、不包装其语义。 */
function loadWatchClient(share) {
  const file = path.join(share, 'sched', 'bin', 'sched.cjs');
  try { return require(file); }
  catch (e) { const err = new Error(`调度客户端加载失败：${file}；${e.message}`); err.exitCode = 3; throw err; }
}

/** 只读一个 JSON；读不到/读坏一律返回 null（调用方按"没有事实"处理，绝不把读不明当授予）。 */
function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 严格看护的 resident 授予核验（R7 对齐真实客户端 hold 的授予语义；R8 补真实授权边界）。
 *
 * 实测（真实 M1，tk-8cf4dab88b014fbc071a）：常驻单由派单员【当拍授予且停留在 granted】——
 * 客户端 hold 的等待判据就是 ['granted','running']，常驻单没有 running 迁移，等是等不来的；
 * 而客户端自己的 validatePermit('start') 只认 running（granted 一律"许可当前不在执行状态"，
 * 那是给普通派发活开的闸，不是给常驻单开的）。所以这里不等待、不伪造 running、不造许可：
 * 改为按共享盘上的【事实】逐条核对（判据与客户端 readTicket / validatePermit / hold 同口径）：
 *   1) SCHED_PERMIT 格式合法（票号:attempt:token）且票号 = 本单；
 *   2) 票据文件（<share>/sched/tickets/<单号>.json，与客户端 readTicket 同一路径与身份判据）
 *      真实存在、无撤单请求，且状态落在 hold 实际接受的开跑集 ['granted','running'] 里 ——
 *      只排除终态不够：waiting/paused/slow 等都不是 hold 会按 granted 放行的状态（R8）；
 *   3) 票面请求确为常驻（request.resident === true）且类别/作业类型与本单一致 ——
 *      普通派发票据不许拿来起常驻服务；
 *   4) 当前 attempt 的 permit 与注入的令牌逐字一致，permit.resident === true（本机真实票据
 *      已核此字段）、machine=本机、类别一致、grantedCores 足额；
 *   5) SCHED_GRANTED_CORES（真实客户端授予时注入）在 1..grantedCores；
 *   6) 驻留租约必须经 client.residentLeaseFile（客户端明确导出的同一份判据，不许在别处另拼路径
 *      或另造字段集）读到：schema/ticketId/machine 一致，**cores 等于真实授予**
 *      （真实 hold 就是按 permit.grantedCores 写租约，R8），且 lease.pid === wrapperPid；
 *   7) 父子归属核的是【事实】不是参数（R8）：本看护进程的实际父进程（生产即 process.ppid，
 *      hold 的直接 spawn 父链，Windows/Git-bash 同此）必须 === wrapperPid —— 调用方把
 *      --wrapper 填成谁的 pid 都证明不了父子关系，只有 OS 的真实父链算数。
 * 任何一条不满足都 {ok:false}：不起服务、不写登记、不伪造许可；票据/租约读不到 = 没有事实 = 拒。
 */
function verifyResidentGrant(opts) {
  const {
    ticketId, share, client, permit, wrapperPid,
    ppid = process.ppid,
    hostname = os.hostname(),
    category = 'other', workType = 'other',
    cores = RESIDENT_CORES,
    env = process.env,
    readJsonFile = readJsonIfExists,
  } = opts || {};
  const no = (reason) => ({ ok: false, reason });
  if (!/^tk-[0-9a-f]{20}$/.test(String(ticketId || ''))) return no('单号格式不合法');
  const m = typeof permit === 'string' ? /^(tk-[0-9a-f]{20}):(a[1-9]\d*):(.+)$/.exec(permit) : null;
  if (!m) return no('缺少许可或格式不合法');
  const [, permitTicket, attemptId, token] = m;
  if (permitTicket !== ticketId) return no('许可票号与本单不一致');
  // 票据本体：与客户端 readTicket 同一路径（paths(share).tickets）、同一身份字段的最小集。
  const ticket = readJsonFile(path.join(String(share || ''), 'sched', 'tickets', `${ticketId}.json`));
  if (!ticket) return no('共享盘上读不到本单票据 —— 没有授予的事实');
  if (ticket.formatVersion !== 1 || ticket.ticketId !== ticketId) return no('票据身份不合法');
  if (TERMINAL_STATES.includes(ticket.state)) return no(`票据已终态（${ticket.state}）—— 终态不是授予`);
  if (!['granted', 'running'].includes(ticket.state)) {
    return no(`票据不在开跑状态（当前 ${ticket.state}）—— 只有 hold 实际接受的 granted/running 算授予`);
  }
  if (ticket.cancelRequested === true) return no('已请求撤单 —— 撤单请求下不起服务');
  if (!ticket.request || ticket.request.resident !== true) return no('本单不是长期占用单 —— 普通票据不许起常驻服务');
  if (ticket.request.category !== category) return no('票据类别与本单申请不符');
  if (!ticket.request.work || ticket.request.work.type !== workType) return no('票据作业类型与本单申请不符');
  if (ticket.currentAttemptId !== attemptId) return no('许可不是当前执行');
  const attempt = Array.isArray(ticket.attempts)
    ? ticket.attempts.find((a) => a && a.attemptId === ticket.currentAttemptId) : null;
  const p = attempt && attempt.permit;
  if (!p) return no('当前执行没有许可');
  if (p.ticketId !== ticketId || p.attemptId !== attemptId || p.token !== token) return no('伪造许可:令牌不符');
  if (p.resident !== true) return no('许可不是常驻授予（permit.resident ≠ true）—— 不许凭它起常驻服务');
  if (p.machine !== hostname) return no('许可机器不符');
  if (p.category !== category) return no('许可类别不符');
  if (!Number.isSafeInteger(p.grantedCores) || p.grantedCores < cores) return no('许可核数不够');
  const g = env ? env.SCHED_GRANTED_CORES : undefined;
  if (g !== undefined && (!/^\d+$/.test(String(g)) || Number(g) < 1 || Number(g) > p.grantedCores)) {
    return no('许可核数环境与授予不符');
  }
  // 驻留租约：授权方（真实客户端 hold）在拉起本进程【之前】写下的归属事实。
  if (!client || typeof client.residentLeaseFile !== 'function') return no('调度客户端没有驻留租约判据 —— 无法核验父子归属');
  const lease = readJsonFile(client.residentLeaseFile(share, ticketId));
  if (!lease) return no('共享盘上读不到驻留租约 —— 授权方没落下归属事实');
  if (lease.schema !== 1 || lease.ticketId !== ticketId) return no('驻留租约身份不合法');
  if (lease.machine !== hostname) return no('驻留租约机器不符');
  if (lease.pid !== wrapperPid) return no('驻留租约不是本看护的包装进程 —— 父子归属不符');
  if (!Number.isSafeInteger(lease.cores) || lease.cores < cores) return no('驻留租约核数不符');
  if (lease.cores !== p.grantedCores) return no('驻留租约核数与真实授予不符 —— 租约不是按本单许可写的');
  // 实际父链（事实，不是参数）：租约 pid 对上 --wrapper 还不够，看护进程的真实父进程必须就是它。
  if (ppid !== wrapperPid) {
    return no(`本看护实际父进程（pid ${ppid}）不是登记的包装进程（pid ${wrapperPid}）—— 父子归属不符`);
  }
  return { ok: true, permit: p };
}

/**
 * 看护一拍的【纯判定】。输入都是现成事实，方便单测逐条钉死：
 *   · 包装进程（启动器）已不在 → 停（wrapperDied: true —— 停成后看护要【优先正式 cancel】自己的票，
 *     cancel 不成才留断租兜底；账能自己收就不等派单员扫）；
 *   · 票据终态（外部 cancel / 其它终态）→ 停：账停，进程也停（治实证缝隙 R2；票已终态，无需再 cancel）；
 *   · 票据不存在（exitCode 2）→ 停：账已不在，不能无账运行；
 *   · 读取持续失败超过预算 → 停（账可能已被派单员按断租超时回收）；
 *   · 其余 → 继续。
 * 返回 {action:'stop', code, reason, wrapperDied?} 或 {action:'continue', unreadable?}。
 */
function watchDecision({ ticketId, wrapperAlive, shareFailMs = 0, shareFailBudgetMs = DEFAULT_SHARE_FAIL_BUDGET_MS, readStatus }) {
  if (wrapperAlive === false) {
    return { action: 'stop', code: 0, wrapperDied: true, reason: '启动器包装进程已不在：停掉自己管理的服务，不留散兵' };
  }
  if (!ticketId) return { action: 'continue' };
  const r = readStatus();
  if (r.ok) {
    if (TERMINAL_STATES.includes(r.state)) {
      return { action: 'stop', code: 0, reason: `调度票据已终态（${r.state}）：账停，进程也停` };
    }
    return { action: 'continue' };
  }
  if (r.missing) {
    return { action: 'stop', code: 0, reason: `调度票据已不存在（${r.error}）：账停，进程也停` };
  }
  if (shareFailMs >= shareFailBudgetMs) {
    return { action: 'stop', code: 3, reason: `调度台持续不可读已约 ${Math.round(shareFailMs / 1000)} 秒（超过 ${Math.round(shareFailBudgetMs / 1000)} 秒预算）：` +
      '账可能已被按断租超时回收，不能无账运行，停掉自己管理的服务' };
  }
  return { action: 'continue', unreadable: true };
}

/**
 * 看护进程主循环：先验授予（严格模式）→ 起服前在登记写锁内确认登记属于本次生命周期（R9）
 * → spawn 自己的 server → 带锁补记 serverPid → 周期判定 → 停也只停自己 spawn 的子树，
 * 且【确认退了】才收场。
 * 退出码透传：server 自行退出 = server 的退出码；外部终态/父链断开 = 0；共享盘持续不可读 = 3
 * （先停自有进程、再尽力退单）；严格模式许可核验不过或登记不属于本次生命周期 = 2（不起服务、
 * 不伪造许可）；停止失败 = 1（不冒充已停止）；收到中断信号 = 130。独立模式（无 --ticket）
 * 不验许可，只看包装进程死活，但起服前的登记归属确认照做。
 * 对归属登记的每次读改写都是一个 record.write.lock 短临界区，锁内重读并核对 --key：
 * 登记已换主（另一个生命周期）就【真正零写入】—— 绝不把自己的 pid/退出时刻拼进别人的
 * 生命周期，旧看护也覆盖不了新实例（R9 实证 tk-37706b11 的丢更新缝隙）。
 * 停树失败时看护【不退出】：有界重试，仍不成就在原地看住现场（hold/账不撤、绝不伪成功、
 * 也绝不另起新单），直到自有进程真退出才收场（退出码 1）—— 看护先退、hold 随后注销而
 * server 还活着的"账/进程脱节"就是这么堵上的。
 */
async function runWatchServer(opts, deps = {}) {
  const d = {
    platform: process.platform,
    cwd: opts.cwd || process.cwd(),
    env: process.env,
    intervalMs: envNum(opts.intervalMs ?? process.env[ENV_WATCH_INTERVAL], DEFAULT_WATCH_INTERVAL_MS),
    shareFailBudgetMs: envNum(opts.shareFailBudgetMs ?? process.env[ENV_SHARE_FAIL_BUDGET], DEFAULT_SHARE_FAIL_BUDGET_MS),
    stopRetries: 3,
    stopRetryDelayMs: 2000,
    verifyGrant: verifyResidentGrant,
    hostname: os.hostname(),
    // 实际父进程是【事实】：生产用本进程真实 ppid（hold 的直接 spawn 父链）；单测可显式注入，
    // 但不许拿 CLI 参数冒充（R8）。
    ppid: process.ppid,
    spawn: cp.spawn.bind(cp),
    stopTree,
    readRecord,
    confirmOwn: confirmOwnRecordLocked,
    updateOwn: updateOwnRecordLocked,
    log: console.log,
    err: console.error,
    kill: (pid, signal) => process.kill(pid, signal),
    exit: (code) => { process.exitCode = code; },
    ...deps,
  };
  let client = deps.client ?? null;
  let lastReadError = null;
  // 客户端懒加载：起看护时共享盘可能正打嗝，加载失败不炸、按"读取失败"走预算逻辑。
  const readStatus = () => {
    if (!opts.ticketId) return { ok: true, state: 'running' };
    if (!client) {
      try { client = loadWatchClient(opts.share); }
      catch (e) { lastReadError = e.message; return { ok: false, error: e.message, missing: false }; }
    }
    try {
      const st = client.status(opts.ticketId, { share: opts.share });
      return { ok: true, state: st && st.state };
    } catch (e) {
      lastReadError = e.message;
      return { ok: false, error: e.message, missing: e.exitCode === 2 };
    }
  };
  // 归属登记只许动【本次自己】的生命周期。每次读改写都是一个 record.write.lock 短临界区
  // （R9）：锁内【重读】并核对本次 key —— 不符 = 【真正零写入】，连写盘的机会都不给。
  // 旧实现"进锁前读一次再交给无锁读改写"是 TOCTOU：旧看护的回写拿旧读整篇把刚接主的
  // 新生命周期盖了回去（R9 实证 tk-37706b11）。
  const updateOwnRecord = (fn) => d.updateOwn(opts.record, opts.key, fn, { err: d.err });

  // ① 严格模式起服务前核验 hold 注入的真实授予（verifyResidentGrant，R7 对齐真实客户端语义）：
  //    常驻单的真实授予态是 granted（不迁移 running），核验按共享盘事实逐条核对：票据在、非终态、
  //    resident 请求、SCHED_PERMIT 票号/令牌与本单一致、机器/类别/核数一致、驻留租约的 pid =
  //    本看护的包装进程。终态、missing、读取不明、缺许可、伪造令牌、普通票据、租约不符一律
  //    【不算授予】：不起服务、不写登记，退出码 2。
  if (opts.ticketId) {
    let granted = false;
    let why = '';
    try {
      const st = readStatus();
      if (!st.ok) why = `调度票据读不到（${st.error}）—— 读取不明不能当授予`;
      else if (TERMINAL_STATES.includes(st.state)) why = `调度票据已终态（${st.state}）—— 终态不是授予`;
      else if (permitTicketId(d.env.SCHED_PERMIT) !== opts.ticketId) why = 'hold 没有注入与本单票号一致的 SCHED_PERMIT';
      else {
        const v = await d.verifyGrant({
          ticketId: opts.ticketId, share: opts.share, client,
          permit: d.env.SCHED_PERMIT, wrapperPid: opts.wrapperPid,
          ppid: d.ppid, hostname: d.hostname, env: d.env,
        });
        if (!v || v.ok !== true) why = `授予核验未通过：${(v && v.reason) || '未知原因'}`;
        else granted = true;
      }
    } catch (e) { why = `授予核验失败：${e.message}`; }
    if (!granted) {
      d.err(`[launcher-watch] 严格模式没有拿到有效授予，不起服务（不伪造许可、不裸跑）：${why}`);
      return 2;
    }
  }

  // ② 起服前在登记写锁的短临界区内确认登记确实属于本次生命周期（R9 实证 tk-37706b11）：
  //    拿到了真授予也一样 —— 登记不存在/已被别的生命周期占着（旧看护回写未落地、登记已换主、
  //    票号或包装进程对不上）就绝不起无登记服务：M1 里"先 spawn 无登记服务、随后才拒写登记"，
  //    新服务就以无可核验登记的裸奔状态留在了机器上。拒绝 = 退出码 2，不起、不写。
  const own = d.confirmOwn(opts.record, { key: opts.key, ticketId: opts.ticketId, wrapperPid: opts.wrapperPid });
  if (!own || own.ok !== true) {
    d.err(`[launcher-watch] 归属登记不是本次生命周期，不起无登记服务（不冒充、不裸跑）：${(own && own.reason) || '未知原因'}`);
    return 2;
  }

  const child = d.spawn(process.execPath, [opts.server, ...(opts.serverArgs || [])], {
    cwd: d.cwd, stdio: 'inherit', windowsHide: true,
  });
  updateOwnRecord((r) => ({
    ...(r || {}),
    watcherPid: process.pid,
    serverPid: child.pid,
    serverStartedAt: new Date().toISOString(),
  }));

  let childExit = null;
  let finished = false;
  let stopFailed = false;
  let doneResolve;
  const done = new Promise((res) => { doneResolve = res; });

  const finish = (fallback, { keepRecord = false } = {}) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!keepRecord) {
      try {
        updateOwnRecord((r) => ({ ...(r || {}), serverExitedAt: new Date().toISOString() }));
      } catch { /* 登记收尾失败不影响退出 */ }
    }
    d.exit(stopFailed ? 1 : (childExit ?? fallback ?? 0));
    doneResolve();
  };

  let stopping = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopOwn = async (reason, code, { cancelTicket = false, cancelReason = '共享盘持续不可读：先停自有进程再退单' } = {}) => {
    if (stopping || finished) return;
    stopping = true;
    d.log(`[launcher-watch] ${reason}`);
    // 有界重试；【确认自有进程真退了】才许收场 —— 看护先退、hold 随后注销而 server 还活着的
    // 账/进程脱节，就是从"停不成也 finish"这条缝里漏出来的。停不成：留在原地看住现场。
    let stopResult = null;
    for (let attempt = 1; attempt <= d.stopRetries; attempt++) {
      stopResult = await d.stopTree(child.pid, { platform: d.platform });
      if (stopResult && stopResult.ok === true) break;
      const detail = (stopResult && stopResult.reason) || '未知原因';
      if (attempt < d.stopRetries) {
        d.err(`[launcher-watch] 停树未确认（第 ${attempt}/${d.stopRetries} 次，pid ${child.pid}）：${detail}；` +
          `${Math.round(d.stopRetryDelayMs / 1000)} 秒后再试。`);
        await sleep(d.stopRetryDelayMs);
      }
    }
    if (!stopResult || stopResult.ok !== true) {
      stopFailed = true;
      d.err(`[launcher-watch] 停止自己管理的服务未确认（pid ${child.pid}，已试 ${d.stopRetries} 次）：` +
        `${(stopResult && stopResult.reason) || '未知原因'}。本看护【不退出】：调度单不撤（账/进程保持一致）、` +
        '绝不冒充已停止、也绝不另起新单，请人工结束该进程树；它退出后本看护即收场（退出码 1，登记如实记退出时刻）。');
      return;   // 不 finish：看护与 hold 都留在原地看住现场，直到自有进程真退出
    }
    if (cancelTicket && opts.ticketId && client) {
      try {
        await client.cancel(opts.ticketId, { share: opts.share, reason: cancelReason });
      } catch (e) {
        d.err(`[launcher-watch] 退单未确认：${e.message}；派单员按断租超时销单兜底。`);
      }
    }
    finish(code);
  };

  const onSignal = () => { void stopOwn('收到中断信号：停掉自己管理的服务并退出', 130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let shareFailSince = null;
  const tick = () => {
    const decision = watchDecision({
      ticketId: opts.ticketId,
      wrapperAlive: pidAlive(opts.wrapperPid, d.kill),
      shareFailMs: shareFailSince === null ? 0 : Date.now() - shareFailSince,
      shareFailBudgetMs: d.shareFailBudgetMs,
      readStatus,
    });
    if (decision.action === 'continue') {
      if (decision.unreadable) {
        if (shareFailSince === null) {
          shareFailSince = Date.now();
          d.err(`[launcher-watch] 调度票据读取失败：${lastReadError}；` +
            `持续超过 ${Math.round(d.shareFailBudgetMs / 1000)} 秒将停止自己管理的服务（预算在派单员断租销单门槛之内，先停进程再退单）`);
        }
      } else {
        shareFailSince = null;
      }
      return;
    }
    void stopOwn(decision.reason, decision.code, {
      // 包装进程死了：停成后【优先正式退自己的单】，cancel 不成才留断租兜底（账能自己收就不等扫）。
      // 共享盘持续不可读（code 3）：先停进程再退单。票据终态/已消失：账已收，不再重复退。
      cancelTicket: decision.code === 3 || decision.wrapperDied === true,
      cancelReason: decision.wrapperDied
        ? '启动器包装进程已不在：看护停服后正式退单'
        : '共享盘持续不可读：先停自有进程再退单',
    });
  };
  const timer = setInterval(() => {
    try { tick(); } catch (e) { d.err(`[launcher-watch] 看护检查失败：${e && e.message}`); }
  }, d.intervalMs);

  child.once('exit', (code, signal) => {
    childExit = code ?? (signal ? 130 : 1);
    // 停树没确认成功期间看护一直没退；自有进程此刻真退了（含人工收场）才许收场，退出码钉成 1 的失败边界。
    finish(null);
  });
  child.once('error', (e) => { childExit = 1; d.err(`[launcher-watch] server 启动失败：${e && e.message}`); finish(1); });

  await done;
  return process.exitCode ?? 0;
}

// ——————— 首次依赖安装的命令形态（Windows 上 npm 是批处理，必须显式 cmd /c 包装） ———————

/**
 * 正式安装命令。Windows 上 npm 解析到 npm.cmd，spawn(shell:false) 不能直接启动批处理，
 * 调度台的命令预检也要求显式 cmd /c 包装；其余平台直接 npm。命令形态两种模式共用：
 * 严格模式交给真实 client.exec 挂号执行，独立模式本地直跑 —— 同一个 argv 构造，不另写一份。
 */
function npmInstallCommand(platform = process.platform, webRoot) {
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npm', 'install'], cwd: webRoot }
    : { command: 'npm', args: ['install'], cwd: webRoot };
}

// 直接被 node 执行时 = 看护进程身份（由 hold / 启动器按 watcherArgv 拉起）。
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] !== '--watch-server') {
    console.error('用法: node core/launcherRuntime.cjs --watch-server --server <server.cjs> --record <登记文件> '
      + '--wrapper <pid> [--ticket <单号> --share <共享盘> --key <生命周期键>] [-- server参数]');
    process.exitCode = 2;
  } else {
    try {
      const opts = parseWatchArgs(argv.slice(1));
      runWatchServer(opts)
        .then((code) => { process.exitCode = code ?? process.exitCode ?? 0; })
        .catch((e) => { console.error(`[launcher-watch] 看护进程失败：${e && e.message}`); process.exitCode = 1; });
    } catch (e) {
      console.error(`[launcher-watch] ${e.message}`);
      process.exitCode = 2;
    }
  }
}

module.exports = {
  RECORD_SCHEMA, RECORD_NAME, RESIDENT_CORES, TERMINAL_STATES,
  DEFAULT_WATCH_INTERVAL_MS, DEFAULT_SHARE_FAIL_BUDGET_MS,
  ENV_WATCH_INTERVAL, ENV_SHARE_FAIL_BUDGET,
  recordPath, readRecord, writeRecord, updateRecord, validRecord,
  recordWriteLockPath, writeRecordLocked, updateOwnRecordLocked, confirmOwnRecordLocked,
  newLifecycleKey, residentTitle, classifyInstance, retireOwnInstance,
  stopTree, pidAlive, acquireLaunchMutex, permitTicketId,
  watcherArgv, parseWatchArgs, loadWatchClient,
  verifyResidentGrant, watchDecision, runWatchServer, npmInstallCommand,
};
