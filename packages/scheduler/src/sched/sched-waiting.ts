/**
 * SCHED-QUEUED-ORPHAN-LIVENESS-1009:挂号端等待心跳的派单员侧判定。
 * 现象:exec 挂号后进程被工具超时掐断或强杀,单子照样排到队首锁机器,授予后还要白占座位
 * 10 分钟才被 reclaimUnstartedGrants 收回(10-09 主机一次 16/17 核已授予、实测只忙 0.4 核)。
 * 新挂号端在排队与授予未开跑期间每 10 秒覆盖写 waiting/<单号>.json(seq 递增),这里每 10 秒扫一次:
 *   · 只看排队中(queued/unsatisfiable)与授予未开跑的本机单——后者与 reclaimUnstartedGrants 同一族边界;
 *   · 文件不在 = 老挂号端、两步式用法,或挂号端写不进心跳时主动撤掉了旧文件,一律不判,照旧走旧规矩
 *     (已见过心跳之后文件消失也一样:新挂号端异常离场不删文件、只留下冻结的 seq,所以「消失」不等于「死了」;
 *     PR #1131 评审建议过「已见后消失继续计时」,那样挂号端写失败时撤掉旧文件就退不回旧规矩,没有采用);
 *   · 判停更只用派单员自己的时钟:记下「本进程观察到 seq 变化」那一拍的 at,seq 连续 120 秒不变才判;
 *     文件里没有时间字段,也绝不拿文件 mtime 与派单员时间相减(跨机钟偏教训,见 sched-contract);
 *   · 记录只在内存里:派单员重启后第一次见只记不判,宁可晚收也不误杀。
 * 判死动作:排队的走与撤单指令同一套事件(finishQueuedTicket),授予未开跑的立即写 finished 终局收回。
 * 善后:判死后删该单的心跳文件(挂号端已不在,没有别人会删);每次扫描再把已终结单留下的残留文件顺手删掉
 * (异常离场的挂号端特意留下的、单子随后被撤单等别的途径终结)。排队中的、投影里还没有的单的文件一概不碰。
 */
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import { finishQueuedTicket } from './sched-commands'
import {
  schedPaths, validateWaitingBeat, WAITING_BEAT_CHECK_MS, WAITING_BEAT_STALE_MS, waitingBeatPath,
  type EventDraft, type TicketSnapshot, type WaitingBeat,
} from './sched-contract'
import { isLocalAttempt } from './sched-project'

/** 排队中的单被判挂号端已不在时的撤单原因(常量原文;客户端 sched.cjs 有逐字副本,测试核对)。 */
export const WAITING_ABANDONED_REASON = '挂号端已不在(等待心跳停更超过 2 分钟，本机回收)'
/** 授予未开跑的本机单被判挂号端已不在时的收回原因(同上)。 */
export const GRANTED_WAITING_ABANDONED_REASON = '授予后挂号端等待心跳停更，按挂号端已不在回收(本机回收)'

export interface WaitingReclaimOptions {
  at: string; share: string; tickets: readonly TicketSnapshot[]
  append: (draft: EventDraft) => unknown; log?: (message: string) => void
}
export interface WaitingTracker { reclaim(options: WaitingReclaimOptions): void }

type WaitingRead = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'ok'; beat: WaitingBeat }

/** 归类:排队中 / 授予未开跑的本机单 / 不归本规则管(null)。授予那一族的边界与 reclaimUnstartedGrants 逐条相同。 */
function waitingKind(ticket: TicketSnapshot): 'queued' | 'granted' | null {
  if (ticket.endedAt !== null) return null
  if (ticket.state === 'queued' || ticket.state === 'unsatisfiable') return 'queued'
  if (ticket.state !== 'granted' || ticket.registerOnly || ticket.request.resident === true) return null
  if (ticket.request.execution === 'auto' || !isLocalAttempt(ticket)) return null
  return 'granted'
}

function readWaitingBeat(share: string, id: string): WaitingRead {
  let raw: string
  try { raw = readFileSync(waitingBeatPath(share, id), 'utf8') } catch (error) {
    // 目录不存在(旧共享盘)与文件不存在同口径:没有等待心跳,不判。
    if (hasCode(error, 'ENOENT')) return { status: 'absent' }
    return { status: 'invalid', reason: `读不出:${errorMessage(error)}` }
  }
  try {
    const beat = validateWaitingBeat(JSON.parse(raw))
    if (beat.ticketId !== id) return { status: 'invalid', reason: `单号与文件名不符:${beat.ticketId}` }
    return { status: 'ok', beat }
  } catch (error) { return { status: 'invalid', reason: errorMessage(error) } }
}

/** 删一张单的心跳文件;不在算删过,其余错误原样抛给调用方决定怎么报。 */
function removeWaitingBeat(share: string, id: string): void {
  try { unlinkSync(waitingBeatPath(share, id)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
}

export function createWaitingTracker(): WaitingTracker {
  /** 单号 → 本进程最近一次观察到 seq 变化时的 seq 与派单员时刻(毫秒)。 */
  const seen = new Map<string, { seq: number; seenAtMs: number }>()
  /** 坏文件只报一次:票离开本规则的两类状态时清键。 */
  const loggedInvalid = new Set<string>()
  /** 残留文件删不掉只报一次:票从投影里消失时清键;读不出 waiting 目录也只报一次,读成功复位。 */
  const loggedSweep = new Set<string>()
  let loggedSweepList = false
  let lastScanMs: number | null = null
  /** 已终结单的残留心跳文件顺手删;只认投影里有、且已终结的单,其余(排队中、刚挂号还没受理、不是单号)一概不碰。 */
  const sweepEnded = (options: WaitingReclaimOptions): void => {
    let names: string[]
    try { names = readdirSync(schedPaths(options.share).waiting) } catch (error) {
      // 旧共享盘没有 waiting 目录:没有残留可清。
      if (!hasCode(error, 'ENOENT') && !loggedSweepList) {
        options.log?.(`[sched] 读不出等待心跳目录,本次不清残留:${errorMessage(error)}`)
        loggedSweepList = true
      }
      return
    }
    loggedSweepList = false
    const tickets = new Map(options.tickets.map(ticket => [ticket.ticketId, ticket]))
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const ticket = tickets.get(name.slice(0, -'.json'.length))
      if (!ticket || ticket.endedAt === null) continue
      try { removeWaitingBeat(options.share, ticket.ticketId) } catch (error) {
        if (!loggedSweep.has(ticket.ticketId)) {
          options.log?.(`[sched] 已终结单的等待心跳文件删除失败:${ticket.ticketId}:${errorMessage(error)}`)
          loggedSweep.add(ticket.ticketId)
        }
      }
    }
    for (const id of [...loggedSweep]) if (!tickets.has(id)) loggedSweep.delete(id)
  }
  return {
    reclaim(options) {
      const nowMs = Date.parse(options.at)
      if (lastScanMs !== null && nowMs - lastScanMs < WAITING_BEAT_CHECK_MS) return
      lastScanMs = nowMs
      const watched = new Set<string>()
      for (const ticket of options.tickets) {
        const kind = waitingKind(ticket)
        if (!kind) continue
        watched.add(ticket.ticketId)
        const read = readWaitingBeat(options.share, ticket.ticketId)
        // 不在 = 没有等待心跳(老挂号端、两步式、挂号端写不进心跳时主动撤了旧文件),照旧规矩、清记录;
        // 新挂号端异常离场不删文件,所以已见过之后再消失也不等于死了(见文件头)。
        if (read.status === 'absent') { seen.delete(ticket.ticketId); continue }
        if (read.status === 'invalid') {
          if (!loggedInvalid.has(ticket.ticketId)) {
            options.log?.(`[sched] 忽略非法等待心跳:${ticket.ticketId}:${read.reason}`)
            loggedInvalid.add(ticket.ticketId)
          }
          continue
        }
        const record = seen.get(ticket.ticketId)
        if (!record || record.seq !== read.beat.seq) { seen.set(ticket.ticketId, { seq: read.beat.seq, seenAtMs: nowMs }); continue }
        const staleMs = nowMs - record.seenAtMs
        if (staleMs < WAITING_BEAT_STALE_MS) continue
        seen.delete(ticket.ticketId)
        options.log?.(`[sched] ${ticket.ticketId}/${ticket.currentAttemptId} 挂号端等待心跳停更 ${Math.round(staleMs / 1_000)} 秒，`
          + `按挂号端已不在${kind === 'queued' ? '撤单' : '收回许可'}`)
        if (kind === 'queued') finishQueuedTicket(options.append, ticket, options.at, WAITING_ABANDONED_REASON)
        else options.append({ at: options.at, type: 'finished', ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId,
          data: { result: ticket.cancelRequested ? 'cancelled' as const : 'failed' as const, terminal: true,
            reason: GRANTED_WAITING_ABANDONED_REASON } })
        // 终局已落流水,挂号端已不在、没有别人会删:当场删掉;删不掉下次扫描随已终结单的残留一并再清。
        try { removeWaitingBeat(options.share, ticket.ticketId) } catch (error) {
          options.log?.(`[sched] 已判死单的等待心跳文件删除失败(下次扫描再清):${ticket.ticketId}:${errorMessage(error)}`)
        }
      }
      for (const id of [...seen.keys()]) if (!watched.has(id)) seen.delete(id)
      for (const id of [...loggedInvalid]) if (!watched.has(id)) loggedInvalid.delete(id)
      sweepEnded(options)
    },
  }
}
