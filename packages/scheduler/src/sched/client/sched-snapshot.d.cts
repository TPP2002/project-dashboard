export type SnapshotReason =
  | 'snapshot-sensitive' | 'snapshot-no-head' | 'snapshot-base-missing' | 'snapshot-missing'
  | 'snapshot-bundle-prerequisite-missing' | 'snapshot-commit-mismatch'
  | 'snapshot-git-failed' | 'snapshot-timeout' | 'snapshot-bad-ticket'

export interface SnapshotFailure {
  ok: false
  reason: SnapshotReason
  step?: string
  detail?: string
  files?: Array<{ path: string; why: 'name' | 'size'; bytes: number }>
}
export interface SnapshotSuccess {
  ok: true
  ticketId: string
  ref: string
  commit: string
  tree: string
  parent: string
  method: 'copy-index' | 'read-tree'
  changedPaths: string[]
  elapsedMs: number
  stepMs: Record<string, number>
}
export interface BundleSuccess {
  ok: true
  bundlePath: string
  base: string
  bytes: number
  elapsedMs: number
}
export interface FetchedSnapshot {
  ok: true
  commit: string
  tree: string
}
export interface FetchFailure extends SnapshotFailure { detail: string }

export interface CreateSnapshotOptions {
  repoPath: string
  ticketId: string
  tempDir?: string
  timeoutMs?: number
  maxFileBytes?: number
}
export interface CreateBundleOptions {
  repoPath: string
  ticketId: string
  mainCommit: string
  destDir: string
  timeoutMs?: number
}
export interface CleanupSnapshotOptions { repoPath: string; ticketId: string; tempDir?: string }
export interface RemoveBundleOptions { destDir: string; ticketId: string }
export interface SweepStaleSnapshotsOptions {
  repoPath: string
  tempDir?: string
  destDir?: string
  maxAgeMs?: number
  now?: number | Date
}
export interface FetchSnapshotOptions {
  mirrorPath: string
  bundlePath: string
  ticketId: string
  expectedCommit: string
  timeoutMs?: number
}
export interface DropFetchedSnapshotOptions { mirrorPath: string; ticketId: string }

export const SNAPSHOT_REF_PREFIX: 'refs/sched/snapshots/'
export const SENSITIVE_NAME_PATTERNS: readonly RegExp[]
export const DEFAULT_MAX_FILE_BYTES: 52428800
export const DEFAULT_TIMEOUT_MS: 120000
export const REASONS: Readonly<{
  SENSITIVE: 'snapshot-sensitive'
  NO_HEAD: 'snapshot-no-head'
  BASE_MISSING: 'snapshot-base-missing'
  MISSING: 'snapshot-missing'
  BUNDLE_PREREQUISITE_MISSING: 'snapshot-bundle-prerequisite-missing'
  COMMIT_MISMATCH: 'snapshot-commit-mismatch'
  GIT_FAILED: 'snapshot-git-failed'
  TIMEOUT: 'snapshot-timeout'
  BAD_TICKET: 'snapshot-bad-ticket'
}>
export function createSnapshot(options: CreateSnapshotOptions): Promise<SnapshotSuccess | SnapshotFailure>
export function createBundle(options: CreateBundleOptions): Promise<BundleSuccess | SnapshotFailure>
export function cleanupSnapshot(options: CleanupSnapshotOptions): Promise<{ removedRef: boolean; removedIndex: boolean }>
export function removeBundle(options: RemoveBundleOptions): Promise<boolean>
export function sweepStaleSnapshots(options: SweepStaleSnapshotsOptions): Promise<{ refs: string[]; files: string[] }>
export function fetchSnapshot(options: FetchSnapshotOptions): Promise<FetchedSnapshot | FetchFailure>
export function dropFetchedSnapshot(options: DropFetchedSnapshotOptions): Promise<boolean>

declare const client: {
  SNAPSHOT_REF_PREFIX: typeof SNAPSHOT_REF_PREFIX
  SENSITIVE_NAME_PATTERNS: typeof SENSITIVE_NAME_PATTERNS
  DEFAULT_MAX_FILE_BYTES: typeof DEFAULT_MAX_FILE_BYTES
  DEFAULT_TIMEOUT_MS: typeof DEFAULT_TIMEOUT_MS
  REASONS: typeof REASONS
  createSnapshot: typeof createSnapshot
  createBundle: typeof createBundle
  cleanupSnapshot: typeof cleanupSnapshot
  removeBundle: typeof removeBundle
  sweepStaleSnapshots: typeof sweepStaleSnapshots
  fetchSnapshot: typeof fetchSnapshot
  dropFetchedSnapshot: typeof dropFetchedSnapshot
}
export default client
