import type { EventDraft, LedgerEvent } from './sched-contract'
import type { ProjectionState } from './sched-project'
import type { BeatBatch } from './sched-reclaim'
import type { LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import type { HandoffContext } from './sched-handoff'
import type { OriginProbe } from './sched-origin-probe'

/** All methods called by the daemon are synchronous cache/intent operations.
 * The cloud service performs transport IO only after tick/commit has returned. */
export interface RemoteDomainContext {
  at: string
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
}
export interface RemoteSchedulerPort {
  readMachines(): LifecycleStatusSnapshot
  readBeats(): BeatBatch
  originProbe: OriginProbe
  reclaim(context: RemoteDomainContext): void
  snapshot(context: RemoteDomainContext): void
  handoff(context: HandoffContext): void
}
