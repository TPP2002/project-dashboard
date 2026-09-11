export interface AuditionEntry { key: string; title: string; path: string; task: string; addedAt: string; status: string }
export interface AuditionIndex { schemaVersion: 1; batches: AuditionEntry[] }
export interface AuditionGroup { id: string; name: string; pitch: string; refs: string; risk: string }
export interface AuditionScene { id: string; name: string; level: number; when: string; screen?: string }
export interface AuditionScreen { id: string; title: string; path: string; width: number; height: number }
export interface AuditionSource {
  platform: string; author: string; title: string; license: string; licenseUrl: string
  url: string; attribution: string; mods: string
}
export interface AuditionClip { scene: string; group: string; files: string[]; desc: string; sources: AuditionSource[] }
export interface AuditionDecision { task: string; did: string; optionGroups: Record<string, string> }
export interface AuditionBatch {
  schemaVersion: number; key: string; title: string; summary: string; task: string; groupNoun: string
  screens: AuditionScreen[]; defaultScreen: string; groups: AuditionGroup[]; scenes: AuditionScene[]
  clips: AuditionClip[]; decisions: AuditionDecision[]; notes: string[]
}
export interface AuditionNote { id: string; scene: string | null; group: string | null; text: string; at: string; by: string }
export type AuditionMark = 'up' | 'down' | null
export type AuditionVerdict = 'like' | 'meh' | 'dislike' | null
export interface AuditionReview { state: '已审阅'; at: string; by: string }
export interface AuditionState {
  schemaVersion: 1; project: string; key: string; notes: AuditionNote[]
  marks: Record<string, Exclude<AuditionMark, null>>
  verdicts: Record<string, Exclude<AuditionVerdict, null>>; review: AuditionReview | null
}
export interface AuditionSummary { notes: number; up: number; down: number; review: AuditionReview | null }
export interface AuditionIndexResult { ok: boolean; project: string; index: AuditionIndex; summaries: Record<string, AuditionSummary> }
export interface AuditionBatchResult { ok: boolean; batch: AuditionBatch; baseDir: string; problems: string[] }
export interface AuditionMutation { ok: boolean; state: AuditionState; mirrored?: boolean; mirrorError?: string }
export interface AuditionOperations {
  note: { text: string; scene?: string | null; group?: string | null }
  'note/delete': { id: string }
  mark: { scene: string; group: string; value: AuditionMark }
  verdict: { group: string; value: AuditionVerdict }
  review: { state: '已审阅' | '未审阅' }
}
