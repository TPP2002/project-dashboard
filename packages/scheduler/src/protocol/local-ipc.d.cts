import type { SubmissionRequest, SubmissionIdentity, JobResult, SchedulerCommand, ProtocolResult, RuntimeScope, CallOptions, PayloadMap, KindBindingMap, ResidentIdentity, SourceProof, Envelope, CloudReply } from './contract.cjs';
import type { ReadSelector, ReadManifest, ProjectionRead, ProjectionChunk } from './read-manifest.cjs';
/** Supplied by the named-pipe/OS adapter, never deserialized from CLI input. */
export interface AuthenticatedLocalPeer { sid: string; pid: number; creationFileTime: string; logonSessionId: string; }
export interface SubmissionContext { cwd: string; }
/** Local execution intent carries no observed identity, permit, lease or process facts. Never sent over SSH. */
export type LocalExecutionRequest =
  { kind: 'local-run'; callId: string; submission: SubmissionIdentity; command: string; args: string[]; cwd: string; env: Record<string, string> }
  | { kind: 'local-run-read'; callId: string; runId: string; stdoutOffset: number; stderrOffset: number; maxBytes: number; waitMs: number }
  | { kind: 'local-run-cancel'; callId: string; runId: string };
export interface LocalExecutionReply {
  kind: 'execution'; runId: string; state: 'queued' | 'running' | 'terminal' | 'unknown';
  stdout: { offset: number; nextOffset: number; bytesBase64: string };
  stderr: { offset: number; nextOffset: number; bytesBase64: string };
  terminal: (JobResult & { exitCode: number | null }) | null; reason?: string;
}
export function validateLocalExecutionReply(input: unknown): LocalExecutionReply;
export interface LocalExecutionIngress {
  accept(peer: AuthenticatedLocalPeer, request: LocalExecutionRequest, options: CallOptions): Promise<LocalExecutionReply>;
}
/** In-process read capability. Gateway persists original request/context and OS peer before forwarding submit. */
export interface SubmissionSourcesPort {
  get(identity: SubmissionIdentity, expectedSource: SourceProof | undefined, options: CallOptions): Promise<
    { status: 'found'; request: SubmissionRequest; source: SourceProof; peer: AuthenticatedLocalPeer; localContext: SubmissionContext }
    | { status: 'unknown'; reason: string }>;
}
export type LocalSemanticRequest = { kind: 'submit'; callId: string; request: SubmissionRequest; localContext: SubmissionContext }
  | { kind: 'command'; callId: string; command: SchedulerCommand }
  | { kind: 'read'; callId: string; selectors: ReadSelector[]; snapshotId: string | null; pageToken: string | null }
  | ({ kind: 'read-object'; callId: string } & Omit<ProjectionRead, 'requestId' | 'scope'>)
  | { kind: 'wait'; callId: string; ticketId: string; afterSeq: number }
  | { kind: 'resident-renew'; callId: string; ticketId: string; attemptId: string; permitToken: string; cores: number }
  | LocalExecutionRequest;
export type LocalSemanticReply = { kind: 'business'; result: ProtocolResult } | { kind: 'read'; manifest: ReadManifest }
  | { kind: 'bytes'; callId: string; chunk: ProjectionChunk }
  | { kind: 'pending'; callId: string; retryAfterMs: number } | LocalExecutionReply;
export function validateLocalSemanticRequest(input: unknown): LocalSemanticRequest;
export interface LocalClientPort { call(request: LocalSemanticRequest, options: CallOptions): Promise<LocalSemanticReply>; }
export interface LocalGatewayPort {
  accept(peer: AuthenticatedLocalPeer, request: LocalSemanticRequest, options: CallOptions): Promise<LocalSemanticReply>;
  captureSubmissionSource(peer: AuthenticatedLocalPeer, callId: string, submissionHash: string): SourceProof;
  captureResidentIdentity(peer: AuthenticatedLocalPeer, request: Extract<LocalSemanticRequest, { kind: 'resident-renew' }>): ResidentIdentity;
}
export type RuntimeScopeNotice = { generation: number } & (
  { connection: 'connected'; scope: RuntimeScope } | { connection: 'disconnected' | 'replacing'; scope: null }
);
export interface RuntimeScopePort {
  current(options: CallOptions): Promise<RuntimeScopeNotice>;
  changes(afterGeneration: number, options: CallOptions): AsyncIterable<RuntimeScopeNotice>;
}
export type NativeObservationKind = 'origin.proof' | 'process.stop-proof' | 'machine.observation' | 'report.started' | 'report.finished'
  | 'execution.heartbeat' | 'resident.renewal' | 'lease.challenge' | 'handoff.observe' | 'snapshot.metadata' | 'launch.notice';
export type NativeObservation = { [K in NativeObservationKind]: { kind: K; payload: PayloadMap[K] }
  & (K extends keyof KindBindingMap ? { identity: KindBindingMap[K] } : { identity?: never }) }[NativeObservationKind];
export interface TrustedExecutionNodePort {
  /** A distinct ACL/credential endpoint; a normal LocalClientPort caller cannot invoke this. Gateway wraps the envelope. */
  acceptObservation(peer: AuthenticatedLocalPeer, observation: Exclude<NativeObservation, { kind: 'lease.challenge' }>, options: CallOptions): Promise<ProtocolResult>;
  /** Allocate and seal the real frame without sending it. Bind the handle to the authenticated peer and connection generation. */
  prepareObservation(peer: AuthenticatedLocalPeer, observation: NativeObservation, options: CallOptions): Promise<{
    preparationId: string; envelope: Envelope<NativeObservationKind>;
  }>;
  /** Send exactly the sealed frame; returns both that frame and the correlated authenticated reply. */
  sendPrepared(peer: AuthenticatedLocalPeer, preparationId: string, options: CallOptions): Promise<{
    envelope: Envelope<NativeObservationKind>; reply: CloudReply;
  }>;
}
