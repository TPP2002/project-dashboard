import deployment from '../sched/client/deployment-config.cjs'
/**
 * 执行端并发分类(卡 CLUSTER-AGENT-SERIAL-GRANTS-IDLE-0924)。派单员(准入)与执行代理(开跑)共用这一张表,
 * 不许两边各写一份。
 *
 * - solo:必须独占整台执行代理——开跑前等别的活全部跑完,它跑的时候不接别的活。
 *   e2e 对时序敏感且要起浏览器与桌面壳;e2e:install、deps、ci:runner:install 会改本机共用的
 *   依赖或装服务;bench 量性能,旁边有活就量不准;mutation 一跑 30-90 分钟、自带 8 路并发且会
 *   复制整个工程,先按老路独占跑,不进并发;calib 的产物 0924 起已按单隔离(每张调度单写
 *   <incoming>/<票号>--<执行号>/ 子目录,汇总按单号收,卡 CLUSTER-CALIB-INCOMING-PER-TICKET-0924),
 *   但「从 solo 改回可并发」是另一条要负责人拍板的决定(见该卡待定点),拍板之前仍按 solo 独占,
 *   不许在本表悄悄改类。
 * - vitest:同一台执行代理上同时最多一件(两份单测撞一台机器会一起超时假红)。
 * - shared:单进程,或并发已由授予核数管住的活,可以和别的活同时跑。
 *
 * 新增作业名必须在这里显式归类(单测逐个核对 JOB_TYPES 的每个键);查不到的作业名一律按 solo,
 * 宁可让它独占,不许它和别的活撞。
 */
export type AgentJobClass = 'solo' | 'vitest' | 'shared'

export const AGENT_JOB_CLASS: Readonly<Record<string, AgentJobClass>> = Object.fromEntries(Object.entries(deployment.getDeploymentConfig().jobs).map(([kind, spec]) => [kind, (spec as { jobClass: AgentJobClass }).jobClass]))

/** 工单没写 kind 的老式单子就是 calib(与 cluster-job.ts 的 DEFAULT_JOB_KIND 同口径)。 */
export function agentJobClass(kind: string | undefined): AgentJobClass {
  const key = kind ?? deployment.getDeploymentConfig().defaultJobKind ?? ''
  return Object.hasOwn(AGENT_JOB_CLASS, key) ? AGENT_JOB_CLASS[key]! : 'solo'
}
