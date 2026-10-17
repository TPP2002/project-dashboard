import { hostname } from 'node:os'
import deployment from './sched/client/deployment-config.cjs'
import type { SchedulerDaemonOptions, SchedulerDaemon } from './sched/sched-daemon'

export const validateConfig = deployment.validateConfig
export const configureDeployment = deployment.configureDeployment

/** Catalog must be selected before loading modules that snapshot deployment defaults. */
export function createSchedulerDaemon(options: SchedulerDaemonOptions & { config?: unknown }): SchedulerDaemon {
  if (options.config !== undefined) deployment.configureDeployment(options.config)
  const config = deployment.getDeploymentConfig()
  if (!options.share || !config.machines.some((machine: { name: string }) => machine.name === options.machine)) {
    throw new Error('[scheduler-config] explicit data directory and configured dispatcher machine required')
  }
  // No transport or synthetic trust fallback. The injected port must provide
  // authenticated facts; the original Windows origin/proc adapters fail closed.
  const readMachines = options.readMachines
  const knownMachines = new Set(config.machines.map((m: { name: string }) => m.name))
  const read = readMachines ?? (() => require('./bot/cluster-lifecycle-status').readLifecycleStatusSnapshot(options.share, undefined, { tolerateMachineFaults: true }))
  return require('./sched/sched-daemon').startSchedulerDaemon({ ...options,
    host: options.host ?? hostname(),
    readMachines: () => {
      const snapshot = read()
      for (const machine of snapshot.machines) if (!knownMachines.has(machine.machine)) throw new Error(`[scheduler-config] unknown machine fact: ${machine.machine}`)
      return snapshot
    },
  })
}
