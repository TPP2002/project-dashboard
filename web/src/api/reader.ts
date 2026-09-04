// 审阅台 REST 客户端(READER-INTO-BOARD)。契约见 server/readerApi.cjs。
const API = '/api/reader'

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') msg = body.error
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export interface ReaderNoteLayerRef { id: string; name: string; file: string; key?: string }
export interface ReaderReportMeta {
  key: string
  title: string
  version?: string
  md: string
  prevMd?: string
  prevLabel?: string
  project: string
  task?: string
  status?: string
  why?: string
  docAnswers?: Record<string, string>
  superseded?: Record<string, string>
  decisionAnchors?: Record<string, string>
}
export interface ReaderBatch {
  id: string
  name: string
  baseline?: string
  dir?: string
  noteLayers?: ReaderNoteLayerRef[]
  reports: ReaderReportMeta[]
}
export interface ReaderManifest {
  schemaVersion: number
  batches: ReaderBatch[]
  pendingIntake?: { items?: string[] }
}
export interface ReaderNote { anchor: string; kind: string; text: string }
export interface ReaderNoteLayer { id: string; name: string; notes: ReaderNote[]; error?: string }
export interface ReaderAnno {
  id: string
  blockId: string
  anchor: string
  quote: string
  text: string
  author: string
  at: string
}
export interface ReaderManifestPayload { ok: boolean; project: string; manifest: ReaderManifest; annoCounts: Record<string, number> }
export interface ReaderReportPayload {
  ok: boolean
  project: string
  batch: { id: string; name: string; baseline?: string }
  report: ReaderReportMeta
  md: string
  prevMd: string | null
  notes: ReaderNoteLayer[]
  annos: ReaderAnno[]
}
export interface ReaderAnnoPostResult { ok: boolean; anno: ReaderAnno; annos: ReaderAnno[]; mirror: boolean; mirrorError?: string; task?: string | null }
export interface ReaderExportResult { ok: boolean; path: string; count: number }

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

export async function fetchReaderManifest(project: string): Promise<ReaderManifestPayload> {
  return asJson<ReaderManifestPayload>(await fetch(`${API}/manifest?${q({ project })}`))
}
export async function fetchReaderReport(project: string, key: string): Promise<ReaderReportPayload> {
  return asJson<ReaderReportPayload>(await fetch(`${API}/report?${q({ project, key })}`))
}
export async function postReaderAnno(
  project: string,
  key: string,
  anno: { blockId: string; anchor: string; quote: string; text: string; author?: string },
): Promise<ReaderAnnoPostResult> {
  return asJson<ReaderAnnoPostResult>(
    await fetch(`${API}/annos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, key, op: 'add', anno }),
    }),
  )
}
export async function deleteReaderAnno(project: string, key: string, id: string): Promise<{ ok: boolean; annos: ReaderAnno[] }> {
  return asJson(
    await fetch(`${API}/annos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, key, op: 'delete', id }),
    }),
  )
}
export async function postReaderExport(project: string, key: string): Promise<ReaderExportResult> {
  return asJson<ReaderExportResult>(
    await fetch(`${API}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, key }),
    }),
  )
}
