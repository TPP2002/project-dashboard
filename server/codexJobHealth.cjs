'use strict';

/**
 * 工单「还在跑 / 失联 / 已完成」三态判定(CODEX-DEAD-SESSION-DETECT,2026-09-02)。
 *
 * 【为什么需要它】工单的 state.json 只在**监工正常收场时**才写 finishedAt。监工被强杀、
 * 崩掉、或者整台机器重启,这个字段就永远是 null —— 于是 codexJobs.cjs 里那句
 * `running: state.finishedAt == null` 会把一个早就死掉的工单一直显示成「还在跑」。
 * 负责人早上打开面板,分不清哪些是真在干活、哪些是尸体。
 *
 * 【为什么不并进 codexJobs.cjs】那个文件头注写明「纯状态推导:不读盘、不看 PID」,
 * 是它能被单测直接喂假数据的前提。活性判定必须探进程、要看时钟,是另一种职责,单独成文件。
 *
 * 【PID 这个信号是不对称的,这是本文件最要紧的一条】
 * 进程号会被系统回收再分配。所以:
 *   · 探到**不在** = 铁证。一个被复用的号只会显示成「在」,绝不会显示成「不在」。
 *   · 探到**在**   = 弱证据。可能只是别的进程捡了这个号,不能凭它断定「还在干活」。
 * 因此本文件从不拿「PID 还在」当作还活着的结论,只拿「PID 没了」当作失联的铁证;
 * 剩下的情形一律再过下面两道时间闸。
 *
 * 三条失联判据,按证据强度排,报最硬的那条:
 *   ① 进程号已经不在                       —— 铁证
 *   ② 超过工单自己声明的超时还没落盘收尾     —— 铁证(监工超时会自己写 finishedAt,
 *      没写就说明监工本人没能活到那一刻)
 *   ③ 对应会话很久没有新事件了              —— 软判据(可能只是在跑一个很慢的活)
 *
 * 判「有没有新动静」只能用会话文件里最后一条事件的 timestamp,**不许用文件修改时间**:
 * Windows 上文件句柄打开期间写入不刷新 LastWriteTime,实测能差十分钟。
 */

/** 会话静默多久算失联(软判据)。 */
const DEFAULT_SILENCE_MS = 20 * 60 * 1000;
/** 超过工单自报超时之后,再宽限多久才判它没收尾(留给收尾/判读本身的时间)。 */
const DEFAULT_OVERDUE_GRACE_MS = 5 * 60 * 1000;

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

/**
 * 探一个进程号还在不在。EPERM = 进程存在但没权限发信号,仍算「在」;
 * ESRCH = 确实没有这个进程。
 */
function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * 判定单个工单的活性。纯函数:进程探测由 options.isAlive 注入,时钟由 options.nowMs 注入,
 * 所以可以直接喂假数据做单测。
 *
 * @param {{ running?: boolean, pid?: number|null, startedAt?: string|null,
 *           timeoutSec?: number|null }} job
 * @returns {{ liveness: 'running'|'stalled'|'finished', stalledReason: string|null,
 *             lastActivityAt: string|null, silentForMs: number|null }}
 */
function classifyJobLiveness(job = {}, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : pidAlive;
  const silenceMs = Number.isFinite(options.silenceMs) ? options.silenceMs : DEFAULT_SILENCE_MS;
  const graceMs = Number.isFinite(options.overdueGraceMs) ? options.overdueGraceMs : DEFAULT_OVERDUE_GRACE_MS;

  const lastActivityAt = typeof options.lastActivityAt === 'string' ? options.lastActivityAt : null;
  const lastActivityMs = parseTime(lastActivityAt);
  const silentForMs = lastActivityMs === null ? null : Math.max(0, nowMs - lastActivityMs);
  const base = { liveness: 'running', stalledReason: null, lastActivityAt, silentForMs };

  if (!job.running) return { ...base, liveness: 'finished' };

  // ① 进程号没了 —— 铁证,优先报它
  const pid = Number.isFinite(job.pid) ? job.pid : null;
  if (pid !== null && !isAlive(pid)) {
    return { ...base, liveness: 'stalled', stalledReason: '它的进程已经不在了,不会再有进展' };
  }

  // ② 早该收工却没留下收尾记录 —— 也是铁证:监工超时会自己写收尾,没写说明监工本人没活到那时候
  const startedMs = parseTime(job.startedAt);
  const timeoutSec = Number.isFinite(job.timeoutSec) && job.timeoutSec > 0 ? job.timeoutSec : null;
  if (startedMs !== null && timeoutSec !== null && nowMs - startedMs > timeoutSec * 1000 + graceMs) {
    return {
      ...base,
      liveness: 'stalled',
      stalledReason: '早就超过了这一单允许的时长,却没有留下收尾记录',
    };
  }

  // ③ 很久没有新动静 —— 软判据。没有会话记录时不据此判失联(可能只是还没建立会话)
  if (silentForMs !== null && silentForMs > silenceMs) {
    return {
      ...base,
      liveness: 'stalled',
      stalledReason: `已经 ${Math.round(silentForMs / 60000)} 分钟没有任何新动静`,
    };
  }

  // PID 还在 / 尚未超时 / 近期有动静 —— 当作真在跑
  if (pid === null && startedMs === null) return { ...base, liveness: 'running' };
  return base;
}

/** 会话按 id 建索引,供工单按 threadId 认领自己的「最后一条事件时间」。 */
function indexSessionsById(sessions = []) {
  const index = new Map();
  for (const session of sessions) {
    const id = session && typeof session.sessionId === 'string' ? session.sessionId
      : (session && typeof session.id === 'string' ? session.id : null);
    if (id) index.set(id, session);
  }
  return index;
}

/**
 * 给一批工单补上活性字段。sessions 可以不给 —— 那时只剩 ①② 两条铁证判据可用,
 * 软判据(静默)失效;工单列表接口就是这种场景,够用且不必为它跑一遍会话全扫。
 */
function attachLiveness(jobs = [], options = {}) {
  const byId = indexSessionsById(options.sessions);
  return jobs.map((job) => {
    if (!job || typeof job !== 'object') return job;
    const session = job.threadId ? byId.get(job.threadId) : undefined;
    const health = classifyJobLiveness(
      {
        running: job.running === true,
        pid: Number.isFinite(job.pid) ? job.pid : null,
        startedAt: job.startedAt || null,
        timeoutSec: Number.isFinite(job.timeoutSec) ? job.timeoutSec : null,
      },
      { ...options, lastActivityAt: session?.lastActivityAt ?? options.lastActivityAt ?? null },
    );
    return { ...job, ...health };
  });
}

module.exports = {
  DEFAULT_OVERDUE_GRACE_MS,
  DEFAULT_SILENCE_MS,
  attachLiveness,
  classifyJobLiveness,
  indexSessionsById,
  pidAlive,
};
