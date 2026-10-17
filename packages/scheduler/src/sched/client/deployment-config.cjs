'use strict'

// Deployment input is administrator-owned, never read from a submission or ledger.
const { readFileSync } = require('node:fs')
const { isAbsolute } = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const SEGMENT = /^[A-Za-z0-9._-]+$/
const NAME = /^[A-Za-z0-9._:-]+$/
const fail = message => { throw new Error(`[scheduler-config] ${message}`) }
function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected object`)
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}: forbidden key ${key}`)
    if (!keys.includes(key)) fail(`${label}: unknown field ${key}`)
  }
  return value
}
function text(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) fail(`${label}: invalid text`)
  return value
}
function strings(value, label, pattern, unique = true) {
  if (!Array.isArray(value)) fail(`${label}: expected array`)
  value.forEach(v => text(v, label, pattern))
  if (unique && new Set(value).size !== value.length) fail(`${label}: duplicate value`)
  return value
}
function number(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}: invalid integer`)
  return value
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label}: expected boolean`); return value }
function one(value, allowed, label) { if (!allowed.includes(value)) fail(`${label}: unknown value ${value}`); return value }
function relative(value, label) {
  text(value, label)
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\') || value.split(/[\\/]/).includes('..')) fail(`${label}: expected contained relative path`)
  return value
}
function grammar(value) {
  record(value, ['kind', 'tools', 'values'], 'args')
  one(value.kind, ['none', 'paths', 'build-flags', 'gradle', 'safe-args', 'tool-config', 'choice'], 'args.kind')
  if (value.kind === 'tool-config') strings(value.tools, 'args.tools', NAME)
  else if (value.tools !== undefined) fail('args.tools: unexpected')
  if (value.kind === 'choice') strings(value.values, 'args.values')
  else if (value.values !== undefined) fail('args.values: unexpected')
  return value
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function validateConfig(input) {
  // JSON roundtrip prevents caller mutation, getters and executable configuration.
  const raw = JSON.parse(JSON.stringify(input))
  record(raw, ['schemaVersion', 'machines', 'projects', 'jobs', 'defaultJobKind', 'legacyProjectId', 'lifecycleBundleName', 'hostMachine', 'spareMachine', 'ci'], 'config')
  if (raw.schemaVersion !== 1) fail('schemaVersion: expected 1')
  if (!Array.isArray(raw.machines) || !Array.isArray(raw.projects)) fail('machines/projects: expected arrays')
  const names = new Set()
  for (const machine of raw.machines) {
    record(machine, ['name', 'dedicated'], 'machine'); text(machine.name, 'machine.name', SEGMENT)
    if (names.has(machine.name.toUpperCase())) fail('machine: duplicate name')
    names.add(machine.name.toUpperCase()); bool(machine.dedicated, 'machine.dedicated')
  }
  const known = value => {
    text(value, 'machine reference', SEGMENT)
    if (!raw.machines.some(m => m.name === value)) fail(`unknown machine ${value}`)
    return value
  }
  const ids = new Set()
  for (const entry of raw.projects) {
    record(entry, ['id', 'aliases', 'title', 'repo', 'remote', 'trunk', 'runtime', 'deps', 'machines', 'preferredMachines', 'accepted', 'intake', 'mergedInto', 'note', 'menu'], 'project')
    text(entry.id, 'project.id', SEGMENT)
    entry.aliases ??= []; strings(entry.aliases, 'project.aliases', SEGMENT)
    for (const id of [entry.id, ...entry.aliases]) { if (ids.has(id)) fail(`duplicate project/alias ${id}`); ids.add(id) }
    entry.title ??= entry.id; text(entry.title, 'project.title'); text(entry.repo, 'project.repo')
    entry.remote ??= null; entry.trunk ??= 'main'; entry.deps ??= null
    if (entry.remote !== null) text(entry.remote, 'project.remote')
    if (entry.trunk !== null) text(entry.trunk, 'project.trunk')
    entry.runtime ??= { node: null, python: null, other: [] }
    record(entry.runtime, ['node', 'python', 'other'], 'runtime')
    for (const key of ['node', 'python']) if (entry.runtime[key] !== null) text(entry.runtime[key], `runtime.${key}`)
    strings(entry.runtime.other, 'runtime.other')
    if (entry.deps !== null) {
      record(entry.deps, ['manifests', 'install'], 'deps'); strings(entry.deps.manifests, 'deps.manifests').forEach(p => relative(p, 'manifest'))
      if (entry.deps.install !== null) { if (!Array.isArray(entry.deps.install)) fail('deps.install: expected array'); entry.deps.install.forEach(a => strings(a, 'deps.install argv', undefined, false)) }
    }
    strings(entry.machines, 'project.machines', SEGMENT).forEach(known)
    if (entry.preferredMachines !== undefined) strings(entry.preferredMachines, 'project.preferredMachines', SEGMENT).forEach(m => { known(m); if (!entry.machines.includes(m)) fail('preferred machine not allowed') })
    bool(entry.accepted, 'project.accepted')
    entry.intake ??= 'registered'; one(entry.intake, ['batch-1', 'batch-2', 'registered', 'deps-unlocked', 'not-applicable', 'merged'], 'project.intake')
    entry.mergedInto ??= null; entry.note ??= ''
    if (typeof entry.note !== 'string') fail('project.note: expected string')
    if (!Array.isArray(entry.menu)) fail('project.menu: expected array')
    if (entry.accepted && (!entry.menu.length || !entry.machines.length)) fail('accepted project requires menu and machines')
    const items = new Set()
    for (const item of entry.menu) {
      record(item, ['id', 'category', 'cores', 'portable', 'pinReason', 'rerunnable', 'ciBorrowable', 'hardTimeoutMin', 'artifacts', 'env', 'args', 'forms'], 'menu item')
      text(item.id, 'item.id', NAME); if (items.has(item.id)) fail('duplicate menu item'); items.add(item.id)
      one(item.category, ['vitest', 'solo', 'shared'], 'item.category')
      if (typeof item.cores === 'object') { record(item.cores, ['min', 'max'], 'cores'); number(item.cores.min, 'cores.min'); number(item.cores.max, 'cores.max', item.cores.min) }
      else number(item.cores, 'cores')
      item.portable ??= true; item.rerunnable ??= true; bool(item.portable, 'portable'); bool(item.rerunnable, 'rerunnable')
      item.pinReason ??= null
      if (!item.portable) one(item.pinReason, ['install-deps', 'needs-android-sdk'], 'pinReason')
      else if (item.pinReason !== null) fail('portable item cannot have pinReason')
      item.ciBorrowable ??= 'never'; one(item.ciBorrowable, ['never', 'always', 'targeted'], 'ciBorrowable')
      if (item.hardTimeoutMin !== undefined) number(item.hardTimeoutMin, 'hardTimeoutMin')
      item.artifacts ??= []; strings(item.artifacts, 'artifacts').forEach(p => relative(p, 'artifact'))
      item.env ??= []; strings(item.env, 'env', /^[A-Za-z_][A-Za-z0-9_]*$/)
      grammar(item.args)
      if (!Array.isArray(item.forms) || !item.forms.length) fail('menu item requires forms')
      for (const form of item.forms) {
        record(form, ['cmd', 'tail', 'emit', 'require', 'drop', 'alias', 'args'], 'form')
        strings(form.cmd, 'form.cmd', undefined, false); if (!form.cmd.length) fail('empty form command')
        one(form.tail, ['none', 'npm', 'args'], 'form.tail')
        for (const key of ['emit', 'require', 'drop']) if (form[key] !== undefined) strings(form[key], `form.${key}`, undefined, key !== 'emit')
        if (form.drop?.some(v => v !== 'maxWorkers')) fail('unknown form.drop')
        if (form.alias !== undefined) { record(form.alias, Object.keys(form.alias), 'form.alias'); Object.values(form.alias).forEach(v => text(v, 'alias')) }
        if (form.args !== undefined) grammar(form.args)
      }
    }
  }
  for (const entry of raw.projects) if (entry.mergedInto !== null && !raw.projects.some(p => p.id === entry.mergedInto)) fail('unknown mergedInto project')
  raw.jobs ??= {}; record(raw.jobs, Object.keys(raw.jobs), 'jobs')
  for (const [kind, job] of Object.entries(raw.jobs)) {
    text(kind, 'job kind', NAME)
    record(job, ['desc', 'argv', 'acceptsTarget', 'workersFlag', 'workersEnv', 'quotaInject', 'fixedEnv', 'needsRound', 'injectShareEnv', 'targetPattern', 'outDirEnv', 'pinOneMachine', 'jobClass'], 'job')
    text(job.desc, 'job.desc'); strings(job.argv, 'job.argv', undefined, false); if (!job.argv.length) fail('empty job argv')
    one(job.jobClass, ['solo', 'vitest', 'shared'], 'jobClass')
    for (const k of ['acceptsTarget', 'quotaInject', 'needsRound', 'injectShareEnv', 'pinOneMachine']) if (job[k] !== undefined) bool(job[k], k)
    for (const k of ['workersFlag', 'workersEnv', 'outDirEnv']) if (job[k] !== undefined) text(job[k], k)
    if (job.fixedEnv !== undefined) { record(job.fixedEnv, Object.keys(job.fixedEnv), 'fixedEnv'); Object.values(job.fixedEnv).forEach(v => { if (typeof v !== 'string') fail('fixedEnv: expected strings') }) }
    if (job.targetPattern !== undefined) { text(job.targetPattern, 'targetPattern'); new RegExp(job.targetPattern) }
  }
  raw.defaultJobKind ??= null
  if (raw.defaultJobKind !== null && !Object.hasOwn(raw.jobs, raw.defaultJobKind)) fail('unknown defaultJobKind')
  raw.legacyProjectId ??= null
  if (raw.legacyProjectId !== null && !raw.projects.some(p => p.id === raw.legacyProjectId)) fail('unknown legacyProjectId')
  raw.lifecycleBundleName ??= null
  if (raw.lifecycleBundleName !== null) text(raw.lifecycleBundleName, 'lifecycleBundleName', /^[A-Za-z0-9._-]+[.]bundle$/)
  raw.hostMachine ??= null; raw.spareMachine ??= null
  for (const k of ['hostMachine', 'spareMachine']) if (raw[k] !== null) known(raw[k])
  raw.ci ??= {}
  record(raw.ci, ['labels', 'takeover', 'reserveCores', 'jitSlotRoot', 'ghPath'], 'ci')
  raw.ci.reserveCores ??= {}; record(raw.ci.reserveCores, Object.keys(raw.ci.reserveCores), 'reserveCores')
  for (const [runner, cores] of Object.entries(raw.ci.reserveCores)) { text(runner, 'runner', SEGMENT); number(cores, 'reserveCores', 0) }
  raw.ci.ghPath ??= 'gh'; text(raw.ci.ghPath, 'ghPath')
  raw.ci.jitSlotRoot ??= null; if (raw.ci.jitSlotRoot !== null) text(raw.ci.jitSlotRoot, 'jitSlotRoot')
  raw.ci.labels ??= null
  if (raw.ci.labels !== null) {
    const labels = raw.ci.labels
    record(labels, ['repo', 'managedLanes', 'untouchableLabels', 'runners', 'machinePolicy', 'exclusiveLane'], 'ci.labels')
    text(labels.repo, 'labels.repo', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    strings(labels.managedLanes, 'managedLanes', NAME); if (!labels.managedLanes.length) fail('empty managedLanes')
    strings(labels.untouchableLabels, 'untouchableLabels', NAME)
    if (labels.managedLanes.some(v => labels.untouchableLabels.includes(v))) fail('managed/untouchable overlap')
    text(labels.exclusiveLane, 'exclusiveLane'); if (!labels.managedLanes.includes(labels.exclusiveLane)) fail('unknown exclusiveLane')
    if (!Array.isArray(labels.runners) || !labels.runners.length) fail('labels requires runners')
    const runnerNames = new Set(), runnerIds = new Set()
    for (const runner of labels.runners) {
      record(runner, ['id', 'name', 'machine', 'labels'], 'runner'); number(runner.id, 'runner.id'); text(runner.name, 'runner.name', SEGMENT); known(runner.machine)
      if (runnerNames.has(runner.name) || runnerIds.has(runner.id)) fail('duplicate runner'); runnerNames.add(runner.name); runnerIds.add(runner.id)
      strings(runner.labels, 'runner.labels', NAME); if (runner.labels.some(v => !labels.managedLanes.includes(v))) fail('unknown runner label')
    }
    record(labels.machinePolicy, Object.keys(labels.machinePolicy), 'machinePolicy')
    for (const [machine, policy] of Object.entries(labels.machinePolicy)) { known(machine); one(policy, ['dynamic', 'pinned'], 'machinePolicy') }
  }
  raw.ci.takeover ??= null
  if (raw.ci.takeover !== null) {
    const takeover = raw.ci.takeover
    record(takeover, ['repo', 'lanes', 'unmanagedLabels', 'prerequisites', 'executors'], 'ci.takeover')
    text(takeover.repo, 'takeover.repo', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    record(takeover.lanes, ['fast', 'main', 'e2e'], 'takeover.lanes')
    for (const lane of ['fast', 'main', 'e2e']) {
      const spec = takeover.lanes[lane]; record(spec, ['lane', 'label', 'workType', 'category', 'jobClass'], 'lane')
      if (spec.lane !== lane) fail('lane identity mismatch'); text(spec.label, 'lane.label', NAME); text(spec.workType, 'lane.workType', NAME)
      one(spec.category, ['unit-test', 'e2e-test'], 'lane.category'); one(spec.jobClass, ['shared', 'vitest'], 'lane.jobClass')
    }
    if (new Set(Object.values(takeover.lanes).map(s => s.label)).size !== 3) fail('duplicate takeover labels')
    strings(takeover.unmanagedLabels, 'unmanagedLabels', NAME)
    if (takeover.unmanagedLabels.some(v => Object.values(takeover.lanes).some(s => s.label === v))) fail('takeover label overlap')
    record(takeover.prerequisites, Object.keys(takeover.prerequisites), 'prerequisites'); Object.values(takeover.prerequisites).forEach(v => strings(v, 'prerequisites'))
    strings(takeover.executors, 'executors', SEGMENT).forEach(known)
    if (!takeover.executors.length) fail('takeover requires executors')
  }
  return freeze(raw)
}

let active
const EMPTY = { schemaVersion: 1, machines: [], projects: [] }
function getDeploymentConfig() {
  if (!active) active = validateConfig(process.env.SCHED_CONFIG ? JSON.parse(readFileSync(process.env.SCHED_CONFIG, 'utf8')) : EMPTY)
  return active
}
function configureDeployment(input) {
  const next = validateConfig(input)
  if (active && !isDeepStrictEqual(active, next)) fail('deployment already initialized; use a separate process for another catalog')
  active = next
  return active
}
function assertDeploymentSubmission(request) {
  const config = getDeploymentConfig()
  const project = config.projects.find(p => p.id === request.project || p.aliases.includes(request.project))
  if (!project?.accepted) fail(`project not accepted: ${request.project}`)
  const menu = project.menu.find(m => m.id === request.work.type)
  if (!menu) fail(`no menu for ${request.work.type}`)
  for (const machine of [...request.allowedMachines, ...(request.origin ? [request.origin] : [])]) {
    if (!config.machines.some(m => m.name === machine)) fail(`unknown machine ${machine}`)
    if (!project.machines.includes(machine)) fail(`machine not allowed for project: ${machine}`)
  }
  if (request.execution === 'cluster' && !Object.hasOwn(config.jobs, request.work.type)) fail(`no cluster job template: ${request.work.type}`)
  if (request.menu) {
    const result = require('./sched-menu.cjs').validateMenuArgs(request.project, request.menu.item, request.menu.args)
    if (!result.ok) fail(`menu arguments refused: ${result.why}`)
  }
}
module.exports = { validateConfig, getDeploymentConfig, configureDeployment, assertDeploymentSubmission }
