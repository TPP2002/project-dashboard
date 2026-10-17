import { cpus, freemem, totalmem, type CpuInfo } from 'node:os'
import type { AgentCiObservation } from './cluster-agent-ci-observer'

/** 一个逻辑核的累计毫秒数；采样端口保留 os.cpus 的字段形状，测试可直接注入。 */
export interface CpuTimesSample {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

export interface AgentCpuLoad {
  cores: number
  busyCores: number
  busyPct: number
  windowSec: 30
  sampledAt: string
}

/**
 * 三十秒窗口的自由内存读数:totalMb 取最新总量(四舍五入),freeMb 取窗口内最低值
 * (向下取整——闸门要看的是窗口里最紧的一刻,不是采样瞬间的运气)。
 * 仅 win32 采样:os.freemem 在 Windows 上是任务管理器的「可用」口径,其他平台的语义不同,
 * 不读数就没有闸,宁缺毋滥(SCHED-MR6-MEMORY-DIMENSION-0924)。
 */
export interface AgentMemoryLoad {
  totalMb: number
  freeMb: number
  windowSec: 30
  sampledAt: string
}

/** CPU 尚无两份有效快照时整组省略；CI 从启动起就能明确表示「未知」；内存读数在心跳的 load.memory 键下。 */
export type AgentLoad = { schema: 1; ci: AgentCiObservation; memory?: AgentMemoryLoad } & Partial<AgentCpuLoad>

const SAMPLE_INTERVAL_MS = 5000
const WINDOW_MS = 30_000
const TIME_FIELDS = ['user', 'nice', 'sys', 'idle', 'irq'] as const

/**
 * 两份相邻快照逐核求忙碌比例再相加；任一核异常则跳过整段，undefined 绝不算成空闲。
 * 这是**保留能力**(回答「机器实际忙成什么样」,不是自己分配核数),T8 账本下线不影响它。
 * 为什么不直接引 scripts/lib/testCpuBudget.ts 里那份同款核时间差算法:常驻代理的换代指纹按
 * cluster-agent.ts 的 SELF_SOURCES 清单逐文件比对**真实导入闭包**(由
 * tests/unit/bot/clusterAgentSelfSourcesClosure.test.ts 钉死),那份清单里没有
 * testCpuBudget.ts,多引一个文件会让清单与闭包对不上;且其中 measureBusyCores 还会同步阻塞
 * 事件循环,不能用于常驻代理。
 */
export function busyCoresFromSamples(
  before: readonly CpuTimesSample[], after: readonly CpuTimesSample[],
): number | undefined {
  if (before.length === 0 || before.length !== after.length) return undefined
  let busyCores = 0
  for (let i = 0; i < before.length; i++) {
    const previous = before[i]!
    const current = after[i]!
    let totalDelta = 0
    for (const field of TIME_FIELDS) {
      if (!Number.isFinite(previous[field]) || !Number.isFinite(current[field])
        || previous[field] < 0 || current[field] < previous[field]) return undefined
      totalDelta += current[field] - previous[field]
    }
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) return undefined
    busyCores += (totalDelta - (current.idle - previous.idle)) / totalDelta
  }
  return busyCores
}

export interface AgentLoadSampler {
  start(): void
  stop(): void
  read(): AgentCpuLoad | undefined
  readMemory(): AgentMemoryLoad | undefined
}

/**
 * 仅在进程内采样，不写盘、不起子进程；作业 await 期间仍按五秒节拍更新。
 * 三十秒窗口只收有效区间的忙碌核数，至少一段有效区间才返回读数；start/stop 幂等。
 * 区间与过期判断只用单调毫秒时钟；墙钟只记采样时间，系统校时不能改变负载读数。
 * 内存读数(readMemory)只在 win32 采;缺省读数口就是 node:os 的 totalmem()/freemem()(生产
 * createAgentLoadSampler() 不传参即用),注入口留给测试。同用五秒节拍与三十秒窗口,
 * 取窗口内最低自由内存;读数失败只丢该段,不牵连 CPU 的相邻快照。
 */
export function createAgentLoadSampler(options: {
  readCpus?: () => readonly Pick<CpuInfo, 'times'>[]
  readMemory?: () => { totalBytes: number; freeBytes: number } | undefined
  platform?: NodeJS.Platform
  now?: () => number
  monotonicNow?: () => number
} = {}): AgentLoadSampler {
  const readCpus = options.readCpus ?? cpus
  const readMemoryFeed = options.readMemory ?? (() => ({ totalBytes: totalmem(), freeBytes: freemem() }))
  const memoryEnabled = (options.platform ?? process.platform) === 'win32'
  const now = options.now ?? (() => new Date().getTime())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let previous: { at: number; times: CpuTimesSample[] } | undefined
  let samples: { start: number; end: number; wallAt: number; cores: number; busyCores: number }[] = []
  let memorySamples: { at: number; wallAt: number; totalBytes: number; freeBytes: number }[] = []

  function prune(at: number): void {
    samples = samples.filter(sample => sample.end <= at)
    const latest = samples[samples.length - 1]
    if (latest === undefined) return
    // 读取时刻只判过期；平均窗口锚定最新有效段，缺测或读取间隙不能挪动窗口。
    if (latest.end <= at - WINDOW_MS) {
      samples = []
      return
    }
    samples = samples.filter(sample => sample.end > latest.end - WINDOW_MS)
  }

  function pruneMemory(at: number): void {
    memorySamples = memorySamples.filter(sample => sample.at <= at)
    const latest = memorySamples[memorySamples.length - 1]
    if (latest === undefined) return
    // 与 CPU 同款窗口语义:读取时刻只判过期,窗口锚定最新样本。
    if (latest.at <= at - WINDOW_MS) {
      memorySamples = []
      return
    }
    memorySamples = memorySamples.filter(sample => sample.at > latest.at - WINDOW_MS)
  }

  function sampleCpu(at: number, wallAt: number): void {
    try {
      const current = { at, wallAt, times: readCpus().map(cpu => ({ ...cpu.times })) }
      const before = previous
      previous = current
      prune(current.at)
      if (before === undefined || current.at <= before.at) return
      const busyCores = busyCoresFromSamples(before.times, current.times)
      if (busyCores === undefined) return
      // 核数改变后不混算不同分母；换核数的那一段已由纯函数判无效。
      samples = samples.filter(entry => entry.cores === current.times.length)
      samples.push({ start: before.at, end: current.at, wallAt: current.wallAt, cores: current.times.length, busyCores })
      prune(current.at)
    } catch {
      // 读核时间失败只丢这一段；恢复时重新建相邻快照，不能把缺测当零拉低平均。
      previous = undefined
    }
  }

  function sample(): void {
    const at = monotonicNow()
    const wallAt = now()
    sampleCpu(at, wallAt)
    if (!memoryEnabled) return
    try {
      const reading = readMemoryFeed()
      // 读数口没给出读数或形状不对,只丢这一段,旧样本照常留在窗口里。
      if (reading === undefined) return
      const { totalBytes, freeBytes } = reading
      if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes) || freeBytes < 0) return
      pruneMemory(at)
      if (memorySamples.length > 0 && at <= memorySamples[memorySamples.length - 1]!.at) return
      memorySamples.push({ at, wallAt, totalBytes, freeBytes })
      pruneMemory(at)
    } catch {
      // 读内存失败只丢这一段;CPU 的相邻快照不受牵连,恢复也无需重建基线。
    }
  }

  return {
    start(): void {
      if (timer !== undefined) return
      previous = undefined
      samples = []
      memorySamples = []
      sample()
      timer = setInterval(sample, SAMPLE_INTERVAL_MS)
      timer.unref()
    },
    stop(): void {
      clearInterval(timer)
      timer = undefined
      previous = undefined
    },
    read(): AgentCpuLoad | undefined {
      prune(monotonicNow())
      const latest = samples[samples.length - 1]
      if (latest === undefined) return undefined
      const windowStart = latest.end - WINDOW_MS
      let weightedBusyCores = 0
      let totalWeight = 0
      // 定时器可能延迟：段内按匀速近似，只以落在三十秒窗口里的毫秒数加权。
      for (const entry of samples) {
        const weight = Math.max(0, Math.min(entry.end, latest.end) - Math.max(entry.start, windowStart))
        weightedBusyCores += entry.busyCores * weight
        totalWeight += weight
      }
      if (totalWeight === 0) return undefined
      const busyCores = Math.round(weightedBusyCores / totalWeight * 10) / 10
      return { cores: latest.cores, busyCores, busyPct: Math.round(busyCores / latest.cores * 1000) / 10,
        windowSec: 30, sampledAt: new Date(latest.wallAt).toISOString() }
    },
    readMemory(): AgentMemoryLoad | undefined {
      pruneMemory(monotonicNow())
      const latest = memorySamples[memorySamples.length - 1]
      if (latest === undefined) return undefined
      let minFreeBytes = Infinity
      for (const sample of memorySamples) {
        if (sample.freeBytes < minFreeBytes) minFreeBytes = sample.freeBytes
      }
      if (!Number.isFinite(minFreeBytes)) return undefined
      return { totalMb: Math.round(latest.totalBytes / 1048576), freeMb: Math.floor(minFreeBytes / 1048576),
        windowSec: 30, sampledAt: new Date(latest.wallAt).toISOString() }
    },
  }
}
