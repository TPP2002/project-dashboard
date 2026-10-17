/** 显式初始化与只读状态入口；不自动把不存在的共享盘建成本机目录。 */
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { hasCode, productionSources } from '../bot/cluster-lifecycle-contract'
import { readLifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import { isoTime, schedControlPaths, type DispatcherHeartbeat, type SchedulerSources } from './sched-contract'
import { createCiPolicyReader } from './sched-ci-policy'
import { createDispatcherConfig, readDispatcherConfig } from './sched-control'
import { decideAdmission } from './sched-decide'
import { initializeScheduler, readLedger } from './sched-ledger'
import { schedulerInputs } from './sched-machines'
import { projectLedger } from './sched-project'

export function initializeDispatcher(share: string, machine: string, createdBy: string, sources: SchedulerSources): void {
  // 先读归属再初始化，已有不同归属时连格式/目录也不动。
  const current = readDispatcherConfig(share)
  if (current && current.machine !== machine) throw new Error('[sched] 已指定其他派单主机，禁止覆盖')
  initializeScheduler(share, sources)
  createDispatcherConfig(share, machine, createdBy, sources)
}

export function dispatcherStatus(share: string, sources: SchedulerSources) {
  const config = readDispatcherConfig(share)
  if (!config) throw new Error('[sched] 尚未指定派单主机')
  const ledger = readLedger(share)
  if (ledger.status !== 'ok') throw new Error(`[sched] 台账不可读:${ledger.status}:${ledger.path}`)
  const state = projectLedger(ledger.value.events)
  const now = isoTime(sources.now())
  // 与派单员同一开关,状态里的可用核数才和真正准入的口径一致(SCHED-CI-COEXIST-0925)。
  const inputs = schedulerInputs({ now, state, dispatcherHost: config.machine,
    ciCoexist: createCiPolicyReader({ share }).mode() === 'coexist',
    snapshot: readLifecycleStatusSnapshot(share, undefined, { tolerateMachineFaults: true }) })
  let heartbeat: DispatcherHeartbeat | undefined
  try { heartbeat = JSON.parse(readFileSync(schedControlPaths(share).heartbeat, 'utf8')) as DispatcherHeartbeat } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  return {
    machine: config.machine, heartbeatAgeMs: heartbeat ? Date.parse(now) - Date.parse(isoTime(heartbeat.at)) : null,
    queued: Object.values(state.tickets).filter(ticket => ticket.state === 'queued' || ticket.state === 'unsatisfiable').length,
    granted: Object.values(state.tickets).filter(ticket => ticket.state === 'granted').length,
    // 状态只展示当前剩余量，不能用模拟派完队列后的余额冒充当前容量。
    machines: decideAdmission({ now, machines: inputs.machines, queue: [] }).machines,
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    const argument = (name: string): string => {
      const index = process.argv.indexOf(name)
      const value = index < 0 ? undefined : process.argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`[sched] 必须指定 ${name}`)
      return value
    }
    const share = argument('--share')
    if (process.argv[2] === 'init') {
      initializeDispatcher(share, argument('--dispatcher-host'), hostname(), productionSources)
      console.log('调度目录与派单主机已初始化')
    } else if (process.argv[2] === 'status') console.log(JSON.stringify(dispatcherStatus(share, productionSources), null, 2))
    else throw new Error('[sched] 用法:init --share <盘> --dispatcher-host <机器> 或 status --share <盘>')
  } catch (error) { console.error(error); process.exitCode = 1 }
}
