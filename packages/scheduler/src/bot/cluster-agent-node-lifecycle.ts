import { hostname } from 'node:os'
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertSameIdentity, buildLifecycleIdentity, hasCode, identityFrom, IDENTITY_FIELDS, LIFECYCLE_NAMESPACE, LIFECYCLE_SCHEMA,
  type LifecycleIdentity, type LifecycleStateRecord, type PublishLifecycleJobOptions,
} from './cluster-lifecycle-contract'
import { lifecyclePaths, readActiveLifecycleControl } from './cluster-lifecycle-control'
import { publishLifecycleJob, readLifecycleStateRecord, scanLifecycleStates, transitionLifecycleJob } from './cluster-lifecycle-state'
import { assertNoActiveTransitionLease, TransitionLeaseBarrierError } from './cluster-lifecycle-lease'
import { claimOwnerLease, commitOwnerLease, renewOwnerLease, releaseOwnerLease, type OwnerLeaseHandle } from './cluster-owner'
import { clusterJobPayload, validateJob, type ClusterJob } from './cluster-job'
import { calibShardToJobShard, reconcileLegacyClaimIdentities } from '../sched/sched-cluster-job'
import type { HandoffPublish, HandoffObserveRequest, HandoffQuarantine } from '../protocol/contract.cjs'
import { validateJobResult } from '../protocol/contract.cjs'
import { readLifecycleStatusSnapshot } from './cluster-lifecycle-status'
import type { AgentLoad } from './cluster-agent-load'

// Fixed migration source has AGENT_PROTOCOL=96. Reader rollout remains controller-owned.
export const AGENT_PROTOCOL = 97

// jobs-v12 stores identity alongside result fields. Validate both identities
// before removing that envelope; unknown result fields still fail the protocol.
export function extractNodeJobResult(record: LifecycleStateRecord, expected: LifecycleIdentity) {
  assertSameIdentity(identityFrom(record, 'node result record'), expected, 'node result record')
  assertSameIdentity(identityFrom(record.result, 'node result envelope'), expected, 'node result envelope')
  const body = { ...record.result }
  for (const field of IDENTITY_FIELDS) delete body[field]
  delete body.suspension // retained in the full immutable resultObject
  return validateJobResult(body)
}

export function publicationFromRemote(share: string, request: HandoffPublish): PublishLifecycleJobOptions {
  const { submission: s, permit, expected } = request
  const job: ClusterJob = {
    ticketId: permit.ticketId, jobId: expected.jobId, kind: s.work.type,
    codeVersion: request.codeRef.value, grantedCores: request.grantedCores,
    ...(permit.ciAware ? { ciAware: true as const } : {}),
  }
  if (s.execution === 'auto') {
    if (!request.snapshot || !s.menu) throw new Error('AUTO_SNAPSHOT_REQUIRED')
    job.auto = { project: s.project, item: s.menu.item, args: [...s.menu.args],
      bundle: request.snapshot.bundle, commit: request.snapshot.commit, base: request.snapshot.base }
  } else {
    if (s.work.targetPaths.length !== 1 || s.work.targetPaths[0] !== '.') job.target = s.work.targetPaths.join(' ')
    if (s.work.workers !== undefined) job.workers = s.work.workers
    if (s.work.round !== undefined) job.round = s.work.round
    if (s.work.shard !== undefined) job.shard = calibShardToJobShard(s.work.shard)
    if (request.queueRank !== undefined) job.queueRank = request.queueRank
    if (request.rerun !== undefined) job.rerun = request.rerun
  }
  const checked = validateJob(job)
  if (!checked.ok) throw new Error(`REMOTE_JOB_INVALID:${checked.reason}`)
  const publication = { share, machine: request.ownerMachine, expectedEpoch: request.lifecycleEpoch,
    jobId: expected.jobId, submissionId: request.submissionId, codeVersion: request.codeRef.value,
    createdAt: request.createdAt, createdBy: s.submitter, payload: clusterJobPayload(job) }
  assertSameIdentity(buildLifecycleIdentity({ ...publication, epoch: request.lifecycleEpoch }), expected, 'remote expected publication')
  return publication
}

export function createNodeLifecycle(options: { share: string; machine: string; head: string }) {
  let owner: OwnerLeaseHandle | undefined
  const control = () => readActiveLifecycleControl({ share: options.share, machine: options.machine })
  const commit = <T>(fn: () => T): T => {
    if (!owner) throw new Error('NODE_OWNER_NOT_STARTED')
    return commitOwnerLease({ handle: owner }, fn)
  }
  function observe(request: HandoffObserveRequest): { state: string; identity: LifecycleIdentity | null; record?: LifecycleStateRecord } {
    if (request.ownerMachine !== options.machine || request.lifecycleEpoch !== control().epoch) throw new Error('LIFECYCLE_SCOPE')
    const paths = lifecyclePaths(options.share, request.lifecycleEpoch, request.ownerMachine)
    let expected = request.expected
    try {
      assertNoActiveTransitionLease(paths, request.submissionId)
      const states = scanLifecycleStates(paths, request.submissionId)
      let claimed = false
      try {
        const claim = identityFrom(JSON.parse(readFileSync(join(paths.claims, `${request.submissionId}.json`), 'utf8')), 'remote claim')
        expected = reconcileLegacyClaimIdentities(claim, expected, request.legacyIdentities ?? [])
        assertSameIdentity(claim, expected, 'remote claim'); claimed = true
      } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      if (states.length > 1 || (states.length > 0 && !claimed)) throw new Error('LIFECYCLE_AMBIGUOUS')
      if (!states.length) return { state: claimed ? 'claim' : 'absent', identity: expected }
      const record = readLifecycleStateRecord({ share: options.share, epoch: request.lifecycleEpoch,
        machine: request.ownerMachine, submissionId: request.submissionId, state: states[0]! })
      assertSameIdentity(record, expected, 'remote lifecycle record')
      return { state: record.state, identity: expected, record }
    } catch (error) {
      if (error instanceof TransitionLeaseBarrierError && error.isLiveAt(Date.now())) return { state: 'transition', identity: expected }
      throw error
    }
  }
  return {
    start() {
      if (owner) return
      const c = control(), paths = lifecyclePaths(options.share, c.epoch, options.machine)
      owner = claimOwnerLease({ ownersDir: paths.owners, head: options.head, identity: {
        name: options.machine, machine: options.machine, pid: process.pid, host: hostname(), protocol: AGENT_PROTOCOL,
        namespace: LIFECYCLE_NAMESPACE, lifecycleSchema: LIFECYCLE_SCHEMA, epoch: c.epoch,
      } })
    },
    renew() { if (!owner) throw new Error('NODE_OWNER_NOT_STARTED'); renewOwnerLease({ handle: owner, head: options.head }) },
    close() { if (owner) { releaseOwnerLease({ handle: owner }); owner = undefined } },
    observe,
    heartbeat(load: AgentLoad, running: number, max: number) {
      return commit(() => {
        const c = control(), paths = lifecyclePaths(options.share, c.epoch, options.machine)
        const heartbeat = { machine: options.machine, state: running ? 'running' : 'idle', at: new Date().toISOString(),
          pid: process.pid, protocol: AGENT_PROTOCOL, head: options.head, ownerPid: process.pid, ownerToken: owner!.token,
          load, jobSlots: { max, running } }
        mkdirSync(paths.heartbeat, { recursive: true })
        const file = join(paths.heartbeat, `${options.machine}.json`), stage = `${file}.${owner!.token}.tmp`
        const fd = openSync(stage, 'w')
        try { writeFileSync(fd, JSON.stringify(heartbeat)); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(stage, file)
        return readLifecycleStatusSnapshot(options.share, undefined, { tolerateMachineFaults: true })
      })
    },
    transition(request: HandoffPublish, to: 'running' | 'done' | 'failed', result?: Record<string, unknown>) {
      return commit(() => {
        const existing = observe(request)
        if (!existing.record) throw new Error('LIFECYCLE_RECORD_UNKNOWN')
        if (existing.state === to) return existing.record
        return transitionLifecycleJob({ share: options.share, epoch: request.lifecycleEpoch, machine: options.machine,
          submissionId: request.submissionId, from: existing.record.state, to,
          ...(result ? { result } : {}) })
      })
    },
    publish(request: HandoffPublish) {
      const publication = publicationFromRemote(options.share, request)
      return commit(() => {
        const existing = observe(request)
        // claim-only and transition are unresolved, never permission to publish again.
        if (existing.state !== 'absent') return existing
        const created = publishLifecycleJob(publication)
        return { state: 'inbox', identity: created.identity, record: created.record }
      })
    },
    quarantine(request: HandoffQuarantine) {
      return commit(() => {
        const existing = observe(request)
        if (!existing.record || !['inbox', 'running'].includes(existing.state)) return existing
        const record = transitionLifecycleJob({ share: options.share, epoch: request.lifecycleEpoch,
          machine: options.machine, submissionId: request.submissionId, from: existing.record.state, to: 'quarantine',
          metadata: { ...existing.record.metadata, reason: request.reason } })
        return { state: 'quarantine', identity: existing.identity, record }
      })
    },
  }
}
