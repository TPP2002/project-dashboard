import deployment from '../sched/client/deployment-config.cjs'
/**
 * cpuLease —— **机器身份与配额换算**(2026-07-29 建;UDQ-T8-LEGACY-LEDGER-RETIRE 最后一刀 2026-09-14 收窄)。
 *
 * 【本文件现在只剩什么】只回答三个问题:这台机器是什么样、它的配额百分比是多少、它允许吃几个核。
 *   · `isDedicatedComputeHost` / `DEDICATED_COMPUTE_HOSTS` —— 专职算力机白名单(不接 CI、没人拿它办公);
 *   · `defaultQuotaPct` / `quotaCores` —— 由那份名单换算出的本机配额(专职机 100%,其余 85%,
 *     `CPU_QUOTA_PCT` 可临时覆盖)。
 * 这三样是**只读的机器事实**:不写文件、不占资源、不排队,故「谁在占算力」这件事脱钩之后照旧有用。
 * 消费者:`scripts/sched/sched-machines.ts`(新调度按它定配额,地基)、`cluster-dispatch`(副机优先)、
 * `cluster-agent-job-execution` / `cluster-agent-orchestrator`(代理按执行机配额注入并发)。
 *
 * 【旧算力账本已经退场(UDQ-T8-LEGACY-LEDGER-RETIRE,2026-09-14)】本文件原先还有一整套
 * 「自己读账本、自己分配核数、自己写租约」的能力:`acquireCpuLease`(放不下就排队等到拿到)、
 * `withLeaseLock`(跨进程临界区)、`ownerReserve` / `setOwnerReserve` / `clearOwnerReserve`(负责人预留)、
 * `cpuLeaseStatus`(只读快照),以及租约目录常量 `LEASE_DIR` 与配套的锁/心跳/僵尸回收代码。
 * 它们已被**统一调度台**(T5 闸,`scripts/lib/schedLocalGate.ts`)取代:重活必须在入口持调度票据
 * (并发=授予核数),轻活由小活池限并发——「自己分配核数」不再有第二个事实源,故整块删除。
 * 机器闸 `tests/unit/bot/legacyLedgerRetireCallers.test.ts` 钉住:调用方一处都不许再接上那套能力,
 * 且本文件的**导出集合必须逐字等于保留清单**(多一个少一个都判红)。
 *
 * ⚠ 看板仓(<dashboard checkout>)的 `core/cpuBudget.cjs` 读的正是那个租约目录,本刀之后它
 * **读不到任何东西**(展示为空)。那是负责人另立的看板卡,不在本单范围。
 *
 * 【为什么白名单按机器名自动判定而不是靠环境变量】专职机是**无人值守**的(开机自启、显示器都撤了),
 * 要求它配环境变量等于每加一台就得跑一趟机房。另外这些机器不接 CI、也没人拿它办公,
 * 存在的意义就是跑计算 ⇒ 允许吃满 100%;其余机器(尤其兼着自托管 CI runner、又是负责人日常
 * 在用的主机)默认压到 85%,把余量留给 CI 和日常操作——**CI 绿是合并四闸门之一,把它挤到超时
 * 等于堵住全项目的合并**。
 */
import { cpus, hostname } from 'node:os'

// ⚠️ 判定函数对来者名字做 toUpperCase() 再查本 Set ⇒ 这里必须写**全大写**,
// 照抄 hostname/心跳文件的原始形式(如 <executor>)会静默不命中。
const DEDICATED_COMPUTE_HOSTS = new Set(deployment.getDeploymentConfig().machines.filter((m: { dedicated: boolean }) => m.dedicated).map((m: { name: string }) => m.name.toUpperCase()))

/**
 * 指定机器是不是专职算力机。
 * 【为什么开这个口子】集群派活要按「专职机优先」排序(cluster-dispatch 自动选机),
 * 判据必须和本文件的配额判据是**同一份名单**——复制第二份的下场是两处口径慢慢漂移,
 * 表现为「配额上按副机算 100%、调度上却没当副机优先」,而且没人报错。
 * @param name 机器名(不给则查本机)
 */
export function isDedicatedComputeHost(name: string = hostname()): boolean {
  return DEDICATED_COMPUTE_HOSTS.has(name.toUpperCase())
}

/** 本机默认配额百分比(专职算力机 100,其余 85)。 */
export function defaultQuotaPct(): number {
  return isDedicatedComputeHost() ? 100 : 85
}

/** 本机配额上限(逻辑核 × 百分比,至少留 1 核可用)。`CPU_QUOTA_PCT` 可临时覆盖(如今晚要用电脑压到 50)。 */
export function quotaCores(): number {
  const dflt = defaultQuotaPct()
  const pct = Number(process.env.CPU_QUOTA_PCT ?? dflt)
  const safePct = Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : dflt
  return Math.max(1, Math.floor(cpus().length * safePct / 100))
}
