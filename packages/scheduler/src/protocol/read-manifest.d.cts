import type { Principal, BusinessCursor, ObjectRef } from './contract.cjs';
import type { TicketSnapshot, SchedulerFormat, DispatcherConfig, DispatcherHeartbeat, CommandReceipt, LedgerEvent, TicketOveruse } from '../sched/sched-contract';
import type { UsageHistoryFile } from '../sched/sched-usage-history';
import type { MemoryFloorConfig } from '../sched/sched-memory-floor';
import type { HubSwitch } from '../sched/client/sched-hub-switch.cjs';
export interface AuthorityReadScope { kind: 'authority-read'; authorityId: string; authorityEpoch: number; }
export type SharedReadKind = 'scheduler-format' | 'dispatcher-config' | 'dispatcher-heartbeat' | 'hub-switch' | 'ci-policy' | 'memory-floor';
export type ExecutionReadKind = 'execution-index' | 'snapshot-metadata' | 'artifact-manifest' | 'artifact-zip' | 'log-descriptor' | 'log-segment' | 'job-result';
export type ReadSelector = { kind: 'ticket'; ticketId: string } | { kind: 'command-receipt'; commandId: string }
  | { kind: 'usage-history' | 'managed-overuse' | 'project-trunk-head'; project: string }
  | { kind: Exclude<ExecutionReadKind, 'log-segment'>; ticketId: string; attemptId: string }
  | { kind: 'log-segment'; ticketId: string; attemptId: string; segmentId: string }
  | { kind: 'ledger-segment'; segmentId: string; fromSeq: number; throughSeq: number }
  | { kind: 'memory-floor'; view: 'config' | 'state' }
  | { kind: Exclude<SharedReadKind, 'memory-floor'> | 'ticket-index' | 'command-receipt-index' | 'ledger-index' };
export type ReadKind = ReadSelector['kind'];
export type ReadAudience = { kind: 'owner' } | { kind: 'authority' } | { kind: 'project'; project: string }
  | { kind: 'machine-project'; machine: string; project: string };
export type ReadAccess = { role: 'owner' } | { role: 'node'; machine: string; projects: string[]; authorityKinds: SharedReadKind[] };
export type ReadEntry = ReadSelector & { snapshotId: string; ledgerCursor: BusinessCursor; object: ObjectRef; audience: ReadAudience;
  contentType: 'application/json' | 'application/x-ndjson' | 'application/zip' | 'text/plain' };
export interface ProjectionCatalog {
  requestId: string; scope: AuthorityReadScope; snapshotId: string | null; pageToken: string | null;
  selectors: ReadSelector[]; limit: number; knownObjects?: { objectId: string; hash: string }[];
}
export interface ReadManifest {
  requestId: string; scope: AuthorityReadScope; snapshotId: string; ledgerCursor: BusinessCursor; issuedAt: string; expiresAt: string;
  entries: ReadEntry[]; nextPageToken: string | null;
}
export interface ProjectionRead { requestId: string; scope: AuthorityReadScope; snapshotId: string; ledgerCursor: BusinessCursor; entry: ReadEntry; offset: number; length: number; }
export interface ProjectionChunk extends ProjectionRead { dataBase64: string; chunkHash: string; }
export interface ReadContext { principal: Principal; authorityId: string; authorityEpoch: number; now: string; maxObjectBytes: number; }
export const READ_KINDS: readonly ReadKind[];
export const SHARED_READ_KINDS: readonly SharedReadKind[];
export const OWNER_ONLY_READ_KINDS: readonly ('ledger-index' | 'ledger-segment')[];
export function validateReadManifest(value: unknown): ReadManifest;
export function authorizeProjectionRead(request: unknown, storedManifest: unknown, context: ReadContext): { allowed: true; entry: ReadEntry } | { allowed: false; reason: string };
export function verifyProjectionObject(bytes: Uint8Array, entry: ReadEntry, storedManifest: ReadManifest, context: ReadContext): {
  bytes: Uint8Array; snapshotId: string; ledgerCursor: BusinessCursor; kind: ReadKind; domainValidated: false;
};
export function dispatcherCompatibilityIdentity(input: { authorityHost: string; ownerMachine: string; authorityPid: number; protocol: number; head: string;
  createdAt: string; createdBy: string }): { authorityHost: string; ownerMachine: string; dispatcherConfig: DispatcherConfig;
    heartbeatIdentity: Pick<DispatcherHeartbeat, 'machine' | 'pid' | 'protocol' | 'head'> };
export interface ObjectDirectory { schema: 1; snapshotId: string; ledgerCursor: BusinessCursor; entries: ReadEntry[]; nextPageToken: string | null; }
export function validateObjectDirectory(value: unknown): ObjectDirectory;
export interface ArtifactManifestBody {
  schema: 1; ticketId: string; attemptId: string; machine: string; state: 'none' | 'zipped' | 'listed' | 'failed';
  zip?: string; zipBytes?: number; totalBytes: number; files: { path: string; bytes: number }[]; truncated?: true;
  rejected: { path: string; why: string }[]; detail?: string; createdAt: string;
}
export interface LogDescriptorBody { schema: 1; ticketId: string; attemptId: string; snapshotId: string; ledgerCursor: BusinessCursor;
  encoding: 'utf-8'; totalBytes: number; segments: Extract<ReadEntry, { kind: 'log-segment' }>[]; nextPageToken: string | null; }
export interface MemoryFloorStateBody { formatVersion: 1; at: string; machines: {
  readonly [machine: string]: { mode: 'open' | 'single' | 'blocked'; reason: string; freeMb: number; totalMb: number;
    floorMb: number; tightMb?: number; sampledAt: string }
}; }
export interface ManagedOveruseBody { formatVersion: 1; at: string; tickets: (TicketOveruse & { ticketId: string })[]; }
export interface MemoryFloorObjectBodies { config: MemoryFloorConfig & { formatVersion: 1 }; state: MemoryFloorStateBody; }
/** Bodies are obtained as bytes. This is a domain mapping, NOT a claim the wire validators validated them.
 * Existing ticket/read/ledger/policy validators must still run against the COMPLETE original body.
 */
export interface ProjectionObjectBodyMap {
  'ticket-index': ObjectDirectory; ticket: TicketSnapshot; 'scheduler-format': SchedulerFormat;
  'dispatcher-config': DispatcherConfig; 'dispatcher-heartbeat': DispatcherHeartbeat;
  'command-receipt-index': ObjectDirectory; 'command-receipt': CommandReceipt; 'ledger-index': ObjectDirectory;
  'ledger-segment': readonly LedgerEvent[]; 'hub-switch': HubSwitch;
  'ci-policy': { formatVersion: 1; mode: 'freeze' | 'coexist'; note?: string };
  'memory-floor': MemoryFloorObjectBodies['config' | 'state']; 'managed-overuse': ManagedOveruseBody;
  'usage-history': UsageHistoryFile; 'project-trunk-head': string; 'execution-index': ObjectDirectory;
  'snapshot-metadata': import('./contract.cjs').SnapshotMetadata; 'artifact-manifest': ArtifactManifestBody;
  'artifact-zip': Uint8Array; 'log-descriptor': LogDescriptorBody; 'log-segment': Uint8Array;
  'job-result': import('./contract.cjs').JobResult & { suspension?: import('../sched/sched-suspend-store').SuspendRecord };
}
