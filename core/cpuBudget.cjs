/**
 * 本机算力账本的只读视图 + 负责人预留开关(2026-08-11 负责人交办)。
 *
 * 【这是什么】同一台主机上同时跑着:多个 Claude 对话、多个 Codex 对话、集群作业、跑分,
 * 外加每个项目各自的自托管 CI runner(实测三个 runner 各绑各的仓库、互相不知情)。
 * 它们都读同一本"谁占了多少核"的账本、按剩余核数决定自己开多少并发。
 *
 * 【看板在这里干什么】只干一件事:往账本里写一条「这些核归负责人」的占用记录。
 * 所有跑测试的进程本来就要读账本让路,所以**消费侧一行代码都不用改**。
 * 释放 = 删掉那条记录,资源立刻回池。
 *
 * 【为什么不 require 项目里的 cpuLease.ts】看板是所有项目共用的工具,不该依赖任何一个项目的
 * 源码(那是 TS、要编译、且项目可能没 checkout)。账本是**文件格式契约**,这里按格式直接读写,
 * 松耦合。契约变更由项目侧的单测钉死(tests/unit/infra/ownerReserve.test.ts)。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 账本目录:与项目侧 scripts/lib/cpuLease.ts 的 LEASE_DIR 必须一致。 */
const LEASE_DIR = process.env.CPU_LEASE_DIR || path.join('F:', 'stock-rogue', '.cpu-leases');
/** 预留租约的固定文件名与 holder 前缀(与项目侧常量对应)。 */
const RESERVE_FILE = 'reserve-owner.json';
const RESERVE_PREFIX = 'reserve:';
/** 普通租约的心跳超时:超过即视为持有进程已死。预留租约豁免此规则(没有进程给它续心跳)。 */
const STALE_MS = 90 * 1000;

/** 专职算力机吃满 100%,其余(尤其兼着 CI runner、又是负责人日常在用的主机)压到 85%。 */
const DEDICATED_HOSTS = new Set(['DESKTOP-B3NF3BA', 'SSUN-TYAO.NBN']);

function quotaPct() {
  return DEDICATED_HOSTS.has(os.hostname().toUpperCase()) ? 100 : 85;
}

function totalCores() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

function quotaCores() {
  const pct = Number(process.env.CPU_QUOTA_PCT || quotaPct());
  const safe = Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : quotaPct();
  return Math.max(1, Math.floor(totalCores() * safe / 100));
}

function isReserve(holder) {
  return typeof holder === 'string' && holder.startsWith(RESERVE_PREFIX);
}

/** 读所有存活租约。只读,不做回收——看板不该替干活的进程清理账本(那是它们自己顺手做的事)。 */
function liveLeases() {
  let files;
  try { files = fs.readdirSync(LEASE_DIR).filter((f) => f.endsWith('.json')); }
  catch (_) { return []; }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(LEASE_DIR, f), 'utf8')); }
    catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (isReserve(rec.holder)) {
      const exp = rec.expiresAt ? new Date(rec.expiresAt).getTime() : undefined;
      if (exp !== undefined && (!Number.isFinite(exp) || now >= exp)) continue;
      out.push(rec);
      continue;
    }
    const beat = new Date(rec.heartbeat).getTime();
    if (!Number.isFinite(beat) || now - beat > STALE_MS) continue;
    out.push(rec);
  }
  return out;
}

/** 账本快照:配额、已占、预留、逐条占用方。 */
function cpuStatus() {
  const leases = liveLeases();
  const used = leases.reduce((n, l) => n + (Number(l.cores) || 0), 0);
  const reserve = leases.find((l) => isReserve(l.holder)) || null;
  const quota = quotaCores();
  return {
    hostname: os.hostname(),
    totalCores: totalCores(),
    quota,
    used,
    free: Math.max(0, quota - used),
    reservedCores: reserve ? Number(reserve.cores) || 0 : 0,
    reserveSince: reserve ? reserve.since : null,
    reserveExpiresAt: reserve && reserve.expiresAt ? reserve.expiresAt : null,
    leases: leases.map((l) => ({
      holder: l.holder,
      cores: Number(l.cores) || 0,
      pid: Number(l.pid) || 0,
      since: l.since,
      isReserve: isReserve(l.holder),
    })),
  };
}

/**
 * 设置负责人预留。覆盖式:重复设置是改数值,不是叠加。
 * cores <= 0 / 坏值 = 释放(滑块拉到底就是「全让给测试」)。超过配额则夹到配额上限。
 */
function setReserve(cores, opts) {
  const options = opts || {};
  const n = Number(cores);
  if (!Number.isFinite(n) || n <= 0) {
    clearReserve();
    return cpuStatus();
  }
  const want = Math.max(1, Math.min(Math.floor(n), quotaCores()));
  fs.mkdirSync(LEASE_DIR, { recursive: true });
  const nowIso = new Date().toISOString();
  const rec = {
    holder: RESERVE_PREFIX + 'owner',
    cores: want,
    pid: 0, // 无进程持有:0 是显式标记,便于一眼看出它不是某个跑批占的
    since: nowIso,
    heartbeat: nowIso,
  };
  if (Number.isFinite(options.expiresAtMs)) {
    rec.expiresAt = new Date(options.expiresAtMs).toISOString();
  }
  fs.writeFileSync(path.join(LEASE_DIR, RESERVE_FILE), JSON.stringify(rec, null, 2));
  return cpuStatus();
}

function clearReserve() {
  try { fs.rmSync(path.join(LEASE_DIR, RESERVE_FILE), { force: true }); } catch (_) { /* 没有就算了 */ }
  return cpuStatus();
}

module.exports = { cpuStatus, setReserve, clearReserve, LEASE_DIR };
