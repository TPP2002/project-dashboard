#!/usr/bin/env node
'use strict'
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { hostname } = require('node:os')
const deployment = require('./sched/client/deployment-config.cjs')
const [command = 'help', ...args] = process.argv.slice(2)
function parse(allowed) {
  const flags = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!allowed.includes(key) || Object.hasOwn(flags, key) || !value || value.startsWith('--')) throw new Error(`Invalid or duplicate option: ${key}`)
    flags[key] = value
  }
  for (const flag of allowed) if (!flags[flag]) throw new Error(`Required: ${flag}`)
  return flags
}
async function main() {
  if (command === 'help' && !args.length) {
    console.log('cloud-scheduler validate-config --config FILE\ncloud-scheduler daemon --data DIRECTORY --config FILE --machine NAME --protocol NUMBER --head SHA\ncloud-scheduler cloud --config ABSOLUTE_FILE\ncloud-scheduler node --config ABSOLUTE_FILE\nData must already be explicitly initialized. No production directories are inferred.')
  } else if (command === 'cloud' || command === 'node') {
    const flags = parse(['--config'])
    const runtime = require('./runtime.cjs')
    const config = runtime.readRuntimeConfig(flags['--config'])
    const service = await (command === 'cloud' ? runtime.startCloudRuntime(config) : runtime.startNodeRuntime(config))
    let stopping = false, monitor
    const stop = async (failed = false) => {
      if (stopping) return
      stopping = true; clearInterval(monitor)
      if (failed) process.exitCode = 1
      try { await service.close() } catch (error) { console.error(error.message); process.exitCode = 1 }
    }
    if (command === 'cloud') monitor = setInterval(() => {
      if (service.health().stopped) {
        console.error('scheduler authority stopped; closing transport for supervised restart')
        void stop(true)
      }
    }, 1000)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void stop()
    })
    console.error(`scheduler ${command} started`)
  } else if (command === 'validate-config') {
    const flags = parse(['--config'])
    const config = deployment.validateConfig(JSON.parse(readFileSync(resolve(flags['--config']), 'utf8')))
    console.log(`scheduler config valid: ${config.machines.length} machines, ${config.projects.length} projects`)
  } else if (command === 'daemon') {
    const flags = parse(['--data', '--config', '--machine', '--protocol', '--head'])
    process.env.SCHED_CONFIG = resolve(flags['--config'])
    const config = deployment.configureDeployment(JSON.parse(readFileSync(process.env.SCHED_CONFIG, 'utf8')))
    if (!config.machines.some(m => m.name === flags['--machine'])) throw new Error('Dispatcher machine not configured')
    const { createSchedulerDaemon } = require('./index.js')
    const { productionSources } = require('./bot/cluster-lifecycle-contract.js')
    const daemon = createSchedulerDaemon({ share: resolve(flags['--data']), config,
      machine: flags['--machine'], host: hostname(), pid: process.pid,
      protocol: Number(flags['--protocol']), head: flags['--head'], sources: productionSources,
      log: message => console.error(`${new Date().toISOString()} ${message}`) })
    const timer = setInterval(() => { try { daemon.tick() } catch (error) { clearInterval(timer); daemon.close(); console.error(error); process.exitCode = 1 } }, 2000)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); daemon.close() })
  } else throw new Error(`Unknown command: ${command}`)
}
main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1 })
