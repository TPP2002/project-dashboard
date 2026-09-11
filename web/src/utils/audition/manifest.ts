import type { AuditionBatch, AuditionSource } from '../../types/audition'

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown) => typeof v === 'string' ? v : ''
const rows = (v: unknown) => Array.isArray(v) ? v.map(record) : []
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const dimension = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback

// 问题清单由服务端保留；这里只给视图可安全读取的形状，不猜缺失的素材或来源。
export function normalizeBatch(value: unknown): AuditionBatch {
  const b = record(value)
  return {
    schemaVersion: typeof b.schemaVersion === 'number' ? b.schemaVersion : 0,
    key: text(b.key), title: text(b.title), summary: text(b.summary), task: text(b.task),
    groupNoun: text(b.groupNoun) || '方向', defaultScreen: text(b.defaultScreen),
    groups: rows(b.groups).filter(g => text(g.id)).map(g => ({ id: text(g.id), name: text(g.name), pitch: text(g.pitch), refs: text(g.refs), risk: text(g.risk) })),
    scenes: rows(b.scenes).filter(s => text(s.id)).map(s => ({ id: text(s.id), name: text(s.name), level: typeof s.level === 'number' ? s.level : 0, when: text(s.when), screen: text(s.screen) })),
    screens: rows(b.screens).filter(s => text(s.id)).map(s => ({ id: text(s.id), title: text(s.title), path: text(s.path), width: dimension(s.width, 1920), height: dimension(s.height, 1080) })),
    clips: rows(b.clips).map(c => ({
      scene: text(c.scene), group: text(c.group), files: strings(c.files), desc: text(c.desc),
      sources: rows(c.sources).map(s => Object.fromEntries(
        ['platform', 'author', 'title', 'license', 'licenseUrl', 'url', 'attribution', 'mods'].map(k => [k, text(s[k])]),
      ) as unknown as AuditionSource),
    })),
    decisions: rows(b.decisions).map(d => ({ task: text(d.task), did: text(d.did), optionGroups: Object.fromEntries(Object.entries(record(d.optionGroups)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) })),
    notes: strings(b.notes),
  }
}

export function clipPath(baseDir: string, file: string): string { return `${baseDir}/${file.replace(/\\/g, '/')}` }
export function markKey(group: string, scene: string): string { return JSON.stringify([group, scene]) }
export function needsAttribution(license: string): boolean { return /CC[ -]BY|Attribution/i.test(license) }
export function safeSourceUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined }
  catch { return undefined }
}
