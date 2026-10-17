/** 同步读阶段的续租点与限频耗时记录。只能由 commit 外的读路径调用。 */
import { SCHED_RENEW_MS } from './sched-owner'

export function createSchedReadProgress(now: () => number, renew: () => void, log?: (message: string) => void) {
  const loggedAt = new Map<string, number>()
  return {
    checkpoint: renew,
    read<T>(stage: string, operation: () => T): T {
      renew()
      const started = now()
      try {
        const value = operation()
        // 失败由调用者硬停止;不在 finally 重复续租覆盖原始 fencing 异常。
        renew()
        return value
      } finally {
        const ended = now()
        if (ended - started >= SCHED_RENEW_MS && ended - (loggedAt.get(stage) ?? -Infinity) >= 60_000) {
          loggedAt.set(stage, ended)
          log?.(`[sched] 慢读阶段 ${stage}: ${ended - started}ms`)
        }
      }
    },
  }
}
