import type { SchedSnapshot } from '../api/sched'

/**
 * 读调度快照的自动重试封装（自愈·前端侧）：首次读取失败时按 2s/5s/10s 退避重试三次
 * （共至多四次读取），期间通过 onRetry 通知调用方「正在重连」（用于在页面上显示重连横幅、并保留
 * 上一次快照不清空）；任一次成功即返回，onRetry(0) 表示已恢复；三次都失败才把错误抛给调用方
 * （由它置 snapshotError）。fetchFn 由调用方传入（典型为 api.fetchSnapshot），不在此处依赖接口模块，
 * 以便使用假接口对象的存量测试替身仍可加载真实 store。
 */
export async function fetchSnapshotWithRetry(
  fetchFn: (signal?: AbortSignal) => Promise<SchedSnapshot>,
  options: { delays?: number[]; signal?: AbortSignal; onRetry?: (attempt: number) => void } = {},
): Promise<SchedSnapshot> {
  const delays = options.delays ?? [2000, 5000, 10000]
  const signal = options.signal
  const onRetry = options.onRetry
  let lastError: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    try {
      const data = await fetchFn(signal)
      onRetry?.(0)
      return data
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      if (attempt < delays.length) {
        onRetry?.(attempt + 1)
        await delayMs(delays[attempt]!, signal)
      }
    }
  }
  throw lastError
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
