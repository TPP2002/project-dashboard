/** Public v1 contract. No implementation of a transport, filesystem or native watchdog is supplied. */
import type { ReadAccess, ProjectionCatalog, ReadManifest, ProjectionRead, ProjectionChunk } from './read-manifest.cjs';
export * from './read-manifest.cjs';
export * from './local-ipc.cjs';
export const PROTOCOL_VERSION: 'scheduler-remote.v1';
export const MAX_FRAME_BYTES: 524288;
export const DEFAULT_LEASE_TTL_MS: 30000;
export const MAX_LEASE_TTL_MS: 60000;
export class ProtocolValidationError extends Error { readonly code: string; readonly path: string; constructor(code: string, path?: string); }
export type Category = 'unit-test' | 'e2e-test' | 'calib-run' | 'perf-bench' | 'mutation-test' | 'codex-build' | 'codex-acceptance' | 'other';
export type TerminalState = 'passed' | 'failed' | 'voided' | 'cancelled';
export type CodeRef = { kind: 'commit' | 'content'; value: string };
export interface ControllerBirth { pid: number; creationFileTime: string; }
export interface SubmissionIdentity { stage: 'submission'; ticketId: string; submissionHash: string; project: string; }
export interface GrantedAttemptIdentity { stage: 'granted'; ticketId: string; attemptId: string; permitToken: string; }
export interface StartedExecutionIdentity { stage: 'started'; ticketId: string; attemptId: string; permitToken: string; controller: ControllerBirth; }
/** ExecutionBinding is deliberately the fully started identity; pre-start kinds use their own table entries. */
export type ExecutionBinding = StartedExecutionIdentity;
export type PhaseIdentity = SubmissionIdentity | GrantedAttemptIdentity | StartedExecutionIdentity;
export type SourceProof = { proofId: string; submissionHash: string; observedOwnerSid: string } & (
  { method: 'original-object-acl'; originalObject: ObjectRef } | { method: 'ipc-peer'; callId: string }
);
export interface ResidentIdentity { stage: 'resident'; ticketId: string; attemptId: string; permitToken: string; renewer: ControllerBirth; source: SourceProof; }
export interface AuthorityScope { authorityId: string; authorityEpoch: number; nodeId: string; nodeSession: string; }
export interface RuntimeScope extends AuthorityScope { gatewayInstance: string; nodeInstance: string; }
export interface SubmissionRequest {
  idempotencyKey: string; project: string; submitter: string; category: Category; title: string;
  work: { type: string; targetPaths: string[]; workers?: number; round?: string; shard?: string };
  requestedCores: number; allowedMachines: string[]; codeRef: CodeRef;
  resources: { exclusive: ('screen' | 'word-com')[] }; createdAt: string;
  parentTicketId?: string; execution?: 'local' | 'cluster' | 'auto'; engine?: string;
  origin?: string; menu?: { item: string; args: string[]; elastic?: true }; resident?: true;
  usageKey?: string; requestedCoresOriginal?: number;
}
export interface CommandDataMap {
  'jump-queue': { ticketId: string }; cancel: { ticketId: string; reason?: string };
  finish: { ticketId: string; result: 'passed' | 'failed'; reason?: string };
  'pause-one': { ticketId: string }; 'resume-one': { ticketId: string };
  reserve: { machine: string; requestedCores: 0 | 5 | 10 | 15; durationMinutes?: 60 | 180 };
  'owner-hold': { machine: string }; 'owner-release': { machine: string };
}
export type SchedulerCommand = { [K in keyof CommandDataMap]: {
  commandId: string; kind: K; data: CommandDataMap[K]; submitter: string; createdAt: string; expiresAt: string;
} }[keyof CommandDataMap];
export interface ReportBase { ticketId: string; attemptId: string; token: string; machine: string; at: string; }
export interface StartedReport extends ReportBase {
  phase: 'started'; pid: number; codeRef: CodeRef; creationFileTime?: string; createdAt?: string;
  verifier?: { pipe: string; publicKey: string };
}
export interface FinishedReport extends ReportBase { phase: 'finished'; result: TerminalState; reason: string; }
export type AttemptReport = StartedReport | FinishedReport;
export interface SuspensionObservation {
  sequence: number; at: number; mode: 'running' | 'paused' | 'slow'; reasons: ('ci' | 'manual' | 'owner-hold')[]; ended: boolean;
  intervals: { from: number; to: number | null }[]; slowIntervals: { from: number; to: number | null }[]; alert: string | null;
}
export interface ExecutionHeartbeat { ticketId: string; attemptId: string; machine: string; at: string; childPid?: number; token?: string; suspend?: SuspensionObservation; }
export interface WaitingUpsert { schema: 1; ticketId: string; machine: string; pid: number; seq: number; }
export type WaitingDelete = Omit<WaitingUpsert, 'pid'>;
export interface ResidentRenewal { schema: 1; ticketId: string; machine: string; cores: number; pid: number; at: string; }
export interface ObjectRef { objectId: string; hash: string; size: number; }
export interface BoundedRead { requestId: string; object: ObjectRef; offset: number; length: number; }
export interface ObjectChunk extends BoundedRead { dataBase64: string; chunkHash: string; }
export interface BusinessCursor { seq: number; hash: string | null; }
export interface ObservationBase { machine: string; requestId: string; observationSequence: number; observedAt: string; }
export type OriginProof = ObservationBase & { ownerMachine: string; codeRef: CodeRef } & (
  { verdict: 'verified' | 'mismatch'; observedOwnerSid: string; source: SourceProof }
  | { verdict: 'unknown'; detail: string; source: SourceProof | null }
);
export interface ProcessStopProof extends ObservationBase { verdict: 'tree-exited' | 'alive' | 'unknown'; method: 'windows-job-object'; evidenceHash: string; }
export interface AgentCiFact {
  state: 'idle' | 'active' | 'unknown'; ciWorkers: number; observedAt: string; stateSince: string;
  runners?: string[]; stale?: true; staleSince?: string;
}
export interface AgentMemoryFact { totalMb: number; freeMb: number; windowSec: 30; sampledAt: string; }
export type AgentLoadFact = { schema: 1; ci: AgentCiFact; memory?: AgentMemoryFact } & (
  { cores: number; busyCores: number; busyPct: number; windowSec: 30; sampledAt: string }
  | { cores?: never; busyCores?: never; busyPct?: never; windowSec?: never; sampledAt?: never }
);
export interface AgentAttemptLoadFact { schema: 1; sampledAt: string; windowSec: 30; attempts: { ticketId: string; attemptId: string; cores: number }[]; }
export interface AgentCiTreeLoadFact { schema: 1; sampledAt: string; windowSec: 30; cores: number; workers: number; }
export interface LifecycleHeartbeatFact {
  machine: string; state: 'idle' | 'maintenance' | 'running' | 'installing-deps' | 'self-upgrading' | 'crashed' | 'code-mismatch';
  at: string; pid: number; protocol: number; head: string; ownerPid: number; ownerToken: string;
  ciYield?: { ciWorkers: number; since: string }; load?: AgentLoadFact; jobSlots?: { max: number; running: number };
  attemptLoad?: AgentAttemptLoadFact; ciTreeLoad?: AgentCiTreeLoadFact;
}
export interface LifecycleControlFact {
  namespace: 'jobs-v12'; lifecycleSchema: 12; epoch: string; state: 'ACTIVE'; codeVersion: string;
  configuredMachines: string[]; createdAt: string; createdBy: string;
}
export interface LifecycleMachineFact {
  machine: string; heartbeat: LifecycleHeartbeatFact | null;
  counts: { inbox: number; running: number; done: number; failed: number; quarantine: number };
  fault?: { kind: 'record-corrupt' | 'identity-drift' | 'record-missing'; reason: string };
}
export interface LifecycleSnapshotFact { control: LifecycleControlFact; machines: LifecycleMachineFact[]; }
export interface MachineObservation { machine: string; observedAt: string; observationSequence: number; lifecycle: LifecycleSnapshotFact; }
export interface RequestOptions { requestId: string; timeoutMs: number; }
export interface OriginRequest extends RequestOptions { machine: string; project: string; codeRef: CodeRef; source?: SourceProof; }
export interface ProcessStopRequest extends RequestOptions { machine: string; action: 'observe' | 'stop'; reason: string; }
export interface SnapshotRequest extends RequestOptions { machine: string; project: string; codeRef: CodeRef; }
export interface HandoffIdentity { submissionId: string; ownerMachine: string; authorityHost: string; intentId: string; lifecycleEpoch: string; }
export interface LifecycleIdentityFact {
  namespace: 'jobs-v12'; lifecycleSchema: 12; epoch: string; jobId: string; submissionId: string; machine: string;
  codeVersion: string; createdAt: string; createdBy: string; payloadSha256: string;
}
export interface HandoffObserveRequest extends HandoffIdentity, RequestOptions { expected: LifecycleIdentityFact; legacyIdentities?: LifecycleIdentityFact[]; }
export interface RemotePermit {
  ticketId: string; attemptId: string; token: string; machine: string; category: Category; grantedCores: number; issuedAt: string;
  ciAware?: true; resident?: true;
}
export interface RerunSelection { identity: { file: string; titlePath: string[]; instanceIndex: number }; sourceSha256: string; }
export interface RerunPlanRecord {
  complete: boolean; eligible: (RerunSelection & { overlapMs: number })[];
  slowTimeouts: number; otherTimeouts: number; retainedFailures: number; sharedHookTimeouts: number; notes: string[];
}
export interface JobResult {
  ok: boolean; exitCode?: number | null; reason?: string;
  notStarted?: { attemptId: string; state: 'granted'; waitedMs: number }; refused?: string; rerunPlan?: RerunPlanRecord;
  logFile?: string; machine?: string; command?: string; finishedAt?: string;
  elapsedSec?: number; rawElapsedSec?: number; suspendedMs?: number; comparable?: boolean; suspensionObject?: ObjectRef;
  artifacts?: { state: 'none' | 'zipped' | 'listed' | 'failed'; manifest?: string; zip?: string; zipBytes?: number; totalBytes?: number; fileCount?: number; detail?: string };
  ciDuringJob?: { maxWorkers: number; firstSeenAt: string; lastSeenAt: string; seenSamples: number; samples: number };
}
export interface HandoffPublish extends HandoffIdentity, RequestOptions {
  expected: LifecycleIdentityFact; codeRef: CodeRef; snapshot: Extract<SnapshotMetadata, { state: 'ready' }> | null; grantedCores: number; createdAt: string;
  submission: SubmissionRequest; permit: RemotePermit; queueRank?: { band: 0 | 1; queuedAt: string }; rerun?: { selection: RerunSelection[] };
}
export interface HandoffObserve extends HandoffIdentity {
  requestId: string; observationSequence: number; observedAt: string;
  identity: LifecycleIdentityFact | null;
  state: 'absent' | 'inbox' | 'claim' | 'transition' | 'running' | 'done' | 'failed' | 'quarantine' | 'unknown';
  result?: JobResult; resultObject?: ObjectRef; exitCode?: number | null; log?: ObjectRef; executionProcess?: { pid: number; createdAt: string }; payloadHash?: string;
  /** Required when result.artifacts names a manifest/zip; never reinterpret resultObject. */
  artifactObjects?: { state: 'ready'; manifest?: ObjectRef; zip?: ObjectRef } | { state: 'unavailable'; reason: string };
}
export interface HandoffQuarantine extends HandoffIdentity, RequestOptions { expected: LifecycleIdentityFact; reason: string; createdAt: string; }
export type SnapshotMetadata = { schema: 1; ticketId: string; attemptId: string; requestId: string; createdAt: string } & (
  { state: 'ready'; commit: string; base: string; object: ObjectRef; bundle: string; bundleBytes: number } | { state: 'refused'; reason: string; detail: string }
);
export interface LaunchNotice { schema: 1; ticketId: string; attemptId: string; submissionId: string; machine: string; token: string; launchedAt: string; }
export interface LeaseChallenge { challenge: string; challengeSequence: number; ledgerSeq: number; requestedTtlMs: number; gatewayInstance: string; nodeInstance: string; }
export interface ExecutionLease extends RuntimeScope, ExecutionBinding {
  ledgerSeq: number; challenge: string; challengeSequence: number; leaseId: string; leaseSequence: number; ttlMs: number;
}
export type ProjectionAttempt = { grantedCores: number; permitLedgerSeq: number; cancelRequested: boolean } & (
  GrantedAttemptIdentity & { state: 'granted' | TerminalState } | StartedExecutionIdentity & { state: 'running' | 'paused' | 'slow' | TerminalState }
);
export interface StateProjection extends RuntimeScope {
  authorityHost: string; ownerMachine: string; requestId: string; snapshotId: string; complete: true; ledgerSeq: number;
  businessCursor: BusinessCursor; sessionWatermark: number; liveWatermark: number; generatedAt: string; attempts: ProjectionAttempt[];
}
export type BusinessOutcome = { kind: 'submission'; ticketId: string } | { kind: 'command'; commandId: string }
  | { kind: 'report'; ticketId: string; attemptId: string; phase: 'started' | 'finished' }
  | { kind: 'applied' } | { kind: 'object'; object: ObjectRef };
export interface ReceiptIdentity { messageId: string; envelopeHash: string; operationKey: string | null; operationHash: string | null; }
export interface DurableReceipt extends ReceiptIdentity { status: 'durably_received'; durableSeq: number; }
export type BusinessReceipt = ReceiptIdentity & { businessCursor: BusinessCursor } & (
  { status: 'business_accepted'; outcome: BusinessOutcome }
  | { status: 'business_rejected'; reason: string }
  | { status: 'business_pending'; reason: string; retryAfterMs: number }
);
export type ProtocolResult = DurableReceipt | BusinessReceipt;
export interface PayloadMap {
  'session.open': { replacesSession: string | null; sessionGeneration: number };
  submission: SubmissionRequest; command: SchedulerCommand;
  'report.started': StartedReport; 'report.finished': FinishedReport;
  'waiting.upsert': WaitingUpsert; 'waiting.delete': WaitingDelete;
  'execution.heartbeat': ExecutionHeartbeat; 'resident.renewal': ResidentRenewal;
  'origin.proof': OriginProof; 'machine.observation': MachineObservation; 'process.stop-proof': ProcessStopProof;
  'origin.request': OriginRequest; 'process.stop-request': ProcessStopRequest; 'snapshot.request': SnapshotRequest;
  'handoff.intent': HandoffPublish; 'handoff.observe-request': HandoffObserveRequest;
  'handoff.publish': HandoffPublish; 'handoff.observe': HandoffObserve; 'handoff.quarantine': HandoffQuarantine;
  'snapshot.metadata': SnapshotMetadata; 'launch.notice': LaunchNotice;
  'artifact.read': BoundedRead; 'log.read': BoundedRead; 'artifact.chunk': ObjectChunk; 'log.chunk': ObjectChunk;
  'state.read': { requestId: string; afterCursor: BusinessCursor; limit: number; ticketId?: string };
  'state.snapshot': StateProjection; 'lease.challenge': LeaseChallenge; 'lease.renewal': ExecutionLease; result: ProtocolResult;
  'projection.catalog': ProjectionCatalog; 'projection.manifest': ReadManifest; 'projection.read': ProjectionRead; 'projection.chunk': ProjectionChunk;
}
export type Kind = keyof PayloadMap;
export type ExecutionKind = 'report.started' | 'report.finished' | 'execution.heartbeat' | 'resident.renewal' | 'origin.proof' | 'origin.request'
  | 'process.stop-request' | 'snapshot.request' | 'handoff.intent' | 'handoff.observe-request'
  | 'process.stop-proof' | 'handoff.publish' | 'handoff.observe' | 'handoff.quarantine' | 'snapshot.metadata' | 'launch.notice'
  | 'artifact.read' | 'log.read' | 'artifact.chunk' | 'log.chunk' | 'lease.challenge' | 'lease.renewal';
export type ImmutableKind = 'submission' | 'command' | 'report.started' | 'report.finished' | 'handoff.intent' | 'handoff.publish' | 'handoff.quarantine' | 'snapshot.metadata' | 'launch.notice';
export interface KindBindingMap {
  'origin.request': SubmissionIdentity; 'origin.proof': SubmissionIdentity;
  'handoff.intent': GrantedAttemptIdentity; 'handoff.publish': GrantedAttemptIdentity;
  'handoff.observe-request': GrantedAttemptIdentity; 'handoff.observe': GrantedAttemptIdentity; 'handoff.quarantine': GrantedAttemptIdentity;
  'snapshot.request': GrantedAttemptIdentity; 'snapshot.metadata': GrantedAttemptIdentity; 'launch.notice': GrantedAttemptIdentity;
  'report.started': StartedExecutionIdentity; 'report.finished': StartedExecutionIdentity; 'execution.heartbeat': StartedExecutionIdentity;
  'resident.renewal': ResidentIdentity; 'process.stop-request': StartedExecutionIdentity; 'process.stop-proof': StartedExecutionIdentity;
  'lease.challenge': StartedExecutionIdentity; 'lease.renewal': StartedExecutionIdentity;
  'artifact.read': PhaseIdentity; 'artifact.chunk': PhaseIdentity; 'log.read': PhaseIdentity; 'log.chunk': PhaseIdentity;
}
export const KINDS: readonly Kind[];
export const IMMUTABLE_KINDS: readonly ImmutableKind[];
export const LIVE_ONLY_KINDS: readonly Kind[];
export const EXECUTION_KINDS: readonly ExecutionKind[];
export const BINDING_STAGES: { readonly [K in keyof KindBindingMap]: readonly KindBindingMap[K]['stage'][] };
export type Envelope<K extends Kind = Kind> = { [P in K]: AuthorityScope & {
  protocolVersion: typeof PROTOCOL_VERSION; messageId: string; sequence: number; kind: P; contentHash: string; payload: PayloadMap[P];
} & (P extends keyof KindBindingMap ? { execution: KindBindingMap[P] } : { execution?: never }) }[K];
export type PeerRole = 'cloud' | 'windows' | 'client';
export const ROUTES: { readonly [K in Kind]: readonly (readonly [PeerRole, PeerRole])[] };
export interface ReplyKindMap {
  'origin.request': 'origin.proof'; 'process.stop-request': 'process.stop-proof';
  'handoff.observe-request': 'handoff.observe'; 'snapshot.request': 'snapshot.metadata';
  'artifact.read': 'artifact.chunk'; 'log.read': 'log.chunk'; 'state.read': 'state.snapshot'; 'lease.challenge': 'lease.renewal';
  'projection.catalog': 'projection.manifest'; 'projection.read': 'projection.chunk';
}
export const REPLY_KINDS: { readonly [K in keyof ReplyKindMap]: ReplyKindMap[K] };
export type TypedReply<K extends Kind> = Envelope<'result'> | (K extends keyof ReplyKindMap ? Envelope<ReplyKindMap[K]> : never);
export interface Principal { id: string; role: PeerRole; nodeIds: string[]; machines: string[]; allowedKinds: Kind[]; nativeObservation?: true; readAccess?: ReadAccess; }
export interface TrustContext { principal: Principal; localRole: PeerRole; authorityId: string; authorityEpoch: number; allowedNodes: string[]; }
export interface EnvelopeContext extends TrustContext { activeSession: string | null; lastSequence: number; }
export interface OperationIdentity { operationKey: string; operationHash: string; }
export interface ValidatedEnvelope {
  envelope: Envelope; transport: { disposition: 'handshake' | 'next' | 'duplicate' | 'out_of_order'; updatesLastSeen: boolean };
  operation: OperationIdentity | null;
}
export function canonicalJson(value: unknown): string;
export function contentHash(value: unknown): string;
export function envelopeHash(value: unknown): string;
export function operationIdentity(value: unknown): OperationIdentity;
export function validateRequest<K extends Kind>(kind: K, value: unknown): PayloadMap[K];
export function validateEnvelope(value: unknown, context: EnvelopeContext): ValidatedEnvelope;
export function validateResult(value: unknown): ProtocolResult;
export function validateLease(value: unknown): ExecutionLease;
export function validateProjection(value: unknown): StateProjection;
export function validateJobResult(value: unknown): JobResult;
export function evaluateResidentReservation(identity: ResidentIdentity, context: {
  expectedIdentity: ResidentIdentity; sourceVerified: boolean; renewalFresh: boolean;
  applicationObservation: 'alive' | 'unknown' | 'exit-confirmed'; applicationBirthVerified: boolean; observationFresh: boolean;
  expectedApplicationBirth: ControllerBirth | null; observedApplicationBirth: ControllerBirth | null;
}): { retain: boolean; reason: string };
export function validateLifecycleSnapshot(value: unknown): LifecycleSnapshotFact;
export function toLifecycleStatusSnapshot(value: unknown): { control: LifecycleControlFact; machines: (Omit<LifecycleMachineFact, 'heartbeat'> & { heartbeat: LifecycleHeartbeatFact | undefined })[] };
export function validateResponse<K extends Kind>(request: Envelope<K>, response: unknown): TypedReply<K>;
export type OriginalOriginProbeResult = { ticketId: string; attemptId: string } & (
  { verdict: 'owner'; ownerSid: string; trusted: boolean } | { verdict: 'failed'; detail: string }
);
/** Shape conversion AFTER authentication/native fact verification; pendingAttemptId is saved cloud context. */
export function toOriginProbeResult(request: Envelope<'origin.request'>, response: Envelope<'origin.proof'>, pendingAttemptId: string): OriginalOriginProbeResult;
export function encodeFrame(value: unknown): string;
export function decodeFrame(value: string | Uint8Array): Envelope;
export interface WaitingWatermark { ticketId: string; seq: number; deleted: boolean; nodeSession: string; transportSequence: number; }
export interface ProtocolState {
  authorityId: string; authorityEpoch: number; nodeId: string; activeSession: string | null; sessionGeneration: number;
  retiredSessions: string[]; lastSequence: number; lastSeenMonotonicMs: number | null; businessCursor: BusinessCursor;
  sessionResult: BusinessReceipt | null;
  messages: { messageId: string; semanticHash: string }[];
  operations: (OperationIdentity & { result: BusinessReceipt | null })[];
  waiting: WaitingWatermark[]; liveStreams: { streamKey: string; sequence: number }[];
}
export type PreparedAcceptance = {
  status: 'ready'; nextState: ProtocolState; validated: ValidatedEnvelope; operation: OperationIdentity | null; liveOnly: boolean;
  effect: { kind: 'message'; messageKind: Kind } | { kind: 'waiting'; entry: WaitingWatermark };
} | { status: 'duplicate'; nextState: ProtocolState; validated: ValidatedEnvelope; operation: OperationIdentity | null; replayResult: BusinessReceipt | null }
  | { status: 'ignored'; reason: string; nextState: ProtocolState; validated: ValidatedEnvelope; operation: OperationIdentity | null }
  | { status: 'rejected'; reason: string };
export function initialProtocolState(scope: Pick<AuthorityScope, 'authorityId' | 'authorityEpoch' | 'nodeId'>): ProtocolState;
export function acceptSessionReply(state: ProtocolState, pendingOpen: Envelope<'session.open'>, reply: unknown, context: TrustContext,
  receivedMonotonicMs: number): Denied | { allowed: true; duplicate: boolean; nextState: ProtocolState };
export function prepareAcceptance(state: ProtocolState, value: unknown, context: TrustContext, receivedMonotonicMs: number): PreparedAcceptance;
export function completeAcceptance(prepared: PreparedAcceptance, result: ProtocolResult): ProtocolState;
export function replayResult(prepared: PreparedAcceptance): BusinessReceipt;
export function isBusinessSuccess(result: unknown): boolean;
export type ClockDomain = 'native-stopwatch' | 'node-performance';
export interface FactFreshness extends RuntimeScope { known: boolean; clockId: string; clockDomain: ClockDomain; observedMonotonicMs: number; }
export interface FreshnessContext extends RuntimeScope { clockId: string; clockDomain: ClockDomain; nowMonotonicMs: number; lastMonotonicMs: number; maxAgeMs: number; }
export function isFactFresh(fact: FactFreshness | null, context: FreshnessContext): boolean;
export interface ProjectionContext extends FreshnessContext {
  freshness: FactFreshness; minLedgerSeq: number; minBusinessCursor: number; minSessionWatermark: number; minLiveWatermark: number;
}
export type Denied = { allowed: false; reason: string };
export function evaluateProjection(projection: unknown, context: ProjectionContext): Denied | { allowed: true; projection: StateProjection };
/** SentAt exists ONLY locally. Never reconstructed from a reply, wall clock, file mtime or remote timestamp. */
export interface LocalChallengeRecord extends RuntimeScope, ExecutionBinding, LeaseChallenge { clockId: string; clockDomain: 'native-stopwatch'; sentAtMonotonicMs: number; }
export interface ExecutionFact extends FactFreshness, ExecutionBinding { machine: string; }
export interface ExecutionContext extends FreshnessContext, ExecutionBinding {
  clockDomain: 'native-stopwatch';
  machine: string; minLedgerSeq: number; executionKnown: boolean; controllerVerified: boolean; nativeWatchdogArmed: boolean; facts: ExecutionFact;
}
export interface LeaseContext extends ExecutionContext {
  challengeRecord: LocalChallengeRecord; lastConsumedChallengeSequence: number; lastLeaseSequence: number; consumedLeaseIds: string[];
}
export interface LeaseWatermarks { lastConsumedChallengeSequence: number; lastLeaseSequence: number; consumedLeaseIds: string[]; lastMonotonicMs: number; }
export interface AcceptedLease { allowed: true; lease: ExecutionLease; deadlineMonotonicMs: number; clockId: string; watermarks: LeaseWatermarks; }
export function evaluateExecutionLease(lease: unknown, context: LeaseContext): Denied | AcceptedLease;
export function evaluateActiveExecutionLease(lease: AcceptedLease, context: ExecutionContext): Denied | { allowed: true; deadlineMonotonicMs: number };
export function evaluateNativeRelease(input: { started: Envelope<'report.started'>; ack: ProtocolResult; projection: StateProjection; lease: AcceptedLease },
  context: { releaseConsumed: boolean; projectionContext: ProjectionContext; executionContext: ExecutionContext }):
  Denied | { allowed: true; deadlineMonotonicMs: number; ticketId: string; attemptId: string };
/** Native host owns this state machine. Stopwatch ticks must be converted in that host's own domain. */
export interface NativeStartGatePort {
  prepare(identity: GrantedAttemptIdentity, menu: { project: string; item: string; args: string[] }, options: CallOptions): Promise<{ gateId: string; controller: ControllerBirth }>;
  recordChallengeSend(gateId: string, challenge: Envelope<'lease.challenge'>): LocalChallengeRecord;
  acceptLease(gateId: string, lease: Envelope<'lease.renewal'>, options: CallOptions): Promise<AcceptedLease | Denied>;
  /** Atomic consume-once release; all three proofs validated in native host, no Node timer in the kill path. */
  release(gateId: string, started: Envelope<'report.started'>, ack: BusinessReceipt, projection: StateProjection, lease: AcceptedLease): void;
}

/** Implementations reject with ProtocolValidationError on invalid input. Port failures never imply a grant. */
export interface PortFailure extends Error { code: 'TIMEOUT' | 'DISCONNECTED' | 'FENCED' | 'NOT_CONFIGURED' | 'IO_FAILURE'; }
export interface CallOptions { timeoutMs: number; }
export type CloudRequestKind = 'origin.request' | 'process.stop-request' | 'handoff.intent' | 'handoff.publish' | 'handoff.observe-request'
  | 'handoff.quarantine' | 'snapshot.request' | 'artifact.read' | 'log.read';
export type CloudRequest = Envelope<CloudRequestKind>;
export type NodeReply = Envelope<'result' | 'origin.proof' | 'process.stop-proof' | 'handoff.observe' | 'snapshot.metadata' | 'artifact.chunk' | 'log.chunk'>;
export type CloudReply = Envelope<'result' | 'state.snapshot' | 'lease.renewal' | 'artifact.chunk' | 'log.chunk' | 'projection.manifest' | 'projection.chunk'> | CloudRequest;
export type CloudInbound = Envelope<'session.open' | 'submission' | 'command' | 'report.started' | 'report.finished' | 'waiting.upsert' | 'waiting.delete'
  | 'execution.heartbeat' | 'resident.renewal' | 'machine.observation' | 'launch.notice' | 'state.read' | 'lease.challenge' | 'artifact.read' | 'log.read' | 'projection.catalog' | 'projection.read'> | NodeReply;
export interface CloudAuthorityPort {
  accept(principal: Principal, envelope: CloudInbound, options: CallOptions): Promise<CloudReply>;
  issue<K extends CloudRequestKind>(principal: Principal, request: Envelope<K>, options: CallOptions): Promise<TypedReply<K>>;
  snapshot(principal: Principal, request: Envelope<'state.read'>, options: CallOptions): Promise<Envelope<'state.snapshot'> | Envelope<'result'>>;
  leaseReply(principal: Principal, challenge: Envelope<'lease.challenge'>, options: CallOptions): Promise<Envelope<'lease.renewal'> | Envelope<'result'>>;
}
export interface GatewayPort {
  exchange(envelope: CloudInbound, options: CallOptions): Promise<CloudReply>;
  send(envelope: CloudInbound, options: CallOptions): Promise<ProtocolResult>;
  receive(options: CallOptions): Promise<CloudReply>;
  respond(response: NodeReply, options: CallOptions): Promise<void>;
  readFreshProjection(context: ProjectionContext): Denied | { allowed: true; projection: StateProjection };
}
export type ObservationRequest = RuntimeScope & (
  { kind: 'origin'; identity: SubmissionIdentity; request: OriginRequest }
  | { kind: 'process-stop'; identity: StartedExecutionIdentity; request: ProcessStopRequest }
);
export type ObservationReply = { status: 'pending'; requestId: string }
  | { status: 'observed'; request: Extract<ObservationRequest, { kind: 'origin' }>; envelope: Envelope<'origin.proof'> }
  | { status: 'observed'; request: Extract<ObservationRequest, { kind: 'process-stop' }>; envelope: Envelope<'process.stop-proof'> }
  | { status: 'unknown'; requestId: string; reason: 'TIMEOUT' | 'DISCONNECTED' | 'FENCED' | 'NOT_CONFIGURED' | 'IO_FAILURE' };
export interface ExecutionObservationPort {
  request(input: ObservationRequest): Promise<{ requestId: string }>;
  take(input: ObservationRequest): Promise<ObservationReply>;
}
export interface HandoffIntent extends RuntimeScope, GrantedAttemptIdentity { publication: HandoffPublish; legacyIdentities?: LifecycleIdentityFact[]; }
export interface HandoffReconciliation { action: 'retain' | 'publish' | 'quarantine' | 'await-started-report' | 'record-finished'; intentId: string; reason: string; }
export interface HandoffPort {
  /** Called synchronously in owner.commit; returns the durable intent draft, performs no IO/network. */
  intent(input: HandoffIntent): HandoffIntent;
  publish(intent: HandoffIntent, options: CallOptions): Promise<Envelope<'result'>>;
  observe(intent: HandoffIntent, options: CallOptions): Promise<Envelope<'handoff.observe'>>;
  quarantine(intent: HandoffIntent, reason: string, options: CallOptions): Promise<Envelope<'result'>>;
  /** Pure synchronous reconciliation of already collected facts, no network in owner.commit. */
  reconcile(intent: HandoffIntent, observation: Envelope<'handoff.observe'> | null): HandoffReconciliation;
}
export interface DurableAcceptancePort {
  /** Resolves only after fencing + domain effects + inbox/identity/result/watermarks are committed and fsynced.
   * CAS checks authority-global operation keys and previous state revision; stale plans fail FENCED.
   * Failure sends no ACK; recovery reads committed result.
   * Live payloads are not stored for later execution; only rejection/dedup/tombstone watermarks persist.
   */
  commit(input: { expectedRevision: string; prepared: PreparedAcceptance; result: ProtocolResult; nextState: ProtocolState }, options: CallOptions): Promise<{ revision: string; result: ProtocolResult }>;
}
