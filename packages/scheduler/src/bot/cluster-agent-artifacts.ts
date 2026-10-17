import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import menu from '../sched/client/sched-menu.cjs'

export interface ArtifactManifest {
  schema: 1
  ticketId: string; attemptId: string; machine: string
  state: 'none' | 'zipped' | 'listed' | 'failed'
  zip?: string; zipBytes?: number
  totalBytes: number
  files: { path: string; bytes: number }[]
  truncated?: true
  rejected: { path: string; why: string }[]
  detail?: string
  createdAt: string
}
export interface ArtifactIo {
  fs?: Partial<typeof fs>
  deflate?: (buffer: Buffer) => Promise<Buffer>
  sleep?: (ms: number) => Promise<void>
  random?: () => string
}
const compress = promisify(deflateRaw)
const fso = (io?: ArtifactIo): typeof fs => Object.assign({}, fs, io?.fs)
const wait = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const retry = [1000, 2000, 4000, 8000, 16000]
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function safeDeclaration(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\')) return false
  const parts = path.replace(/\/$/, '').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return false
  return parts.every(part => part === '*' || menu.isSafeRelativePath(part))
}
async function zipEntries(entries: { path: string; body: Buffer }[], io?: ArtifactIo): Promise<Buffer> {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const filename = Buffer.from(entry.path, 'utf8')
    const compressed = await (io?.deflate ?? compress)(entry.body)
    const stored = compressed.length >= entry.body.length
    const body = stored ? entry.body : compressed
    const method = stored ? 0 : 8
    const crc = crc32(entry.body)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(method, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(entry.body.length, 22)
    head.writeUInt16LE(filename.length, 26)
    local.push(head, filename, body)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(entry.body.length, 24)
    record.writeUInt16LE(filename.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, filename)
    offset += head.length + filename.length + body.length
  }
  const centralBytes = central.reduce((total, item) => total + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}
async function renameWithRetry(from: string, to: string, io?: ArtifactIo): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fso(io).rename(from, to); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt === retry.length) throw error
      await (io?.sleep ?? wait)(retry[attempt]!)
    }
  }
}
async function publish(path: string, body: Buffer | string, io?: ArtifactIo): Promise<void> {
  const tmp = join(resolve(path, '..'), `.${path.split(/[\\/]/).at(-1)!}.tmp-${process.pid}-${io?.random?.() ?? randomBytes(6).toString('hex')}`)
  try { await fso(io).writeFile(tmp, body); await renameWithRetry(tmp, path, io) }
  finally { await fso(io).unlink(tmp).catch(() => {}) }
}

export async function packArtifacts(input: {
  worktree: string; declared: readonly string[]; share: string; ticketId: string
  attemptId: string; machine: string; maxBytes?: number; maxFiles?: number; now?: () => Date
  /** Explicit node-owned object root; absent preserves the original local layout. */
  artifactRoot?: string
}, io?: ArtifactIo): Promise<ArtifactManifest> {
  const manifest: ArtifactManifest = { schema: 1, ticketId: input.ticketId, attemptId: input.attemptId,
    machine: input.machine, state: 'none', totalBytes: 0, files: [], rejected: [],
    createdAt: (input.now ?? (() => new Date()))().toISOString() }
  if (!input.declared.length) return manifest
  const out = input.artifactRoot === undefined ? join(input.share, 'sched', 'artifacts')
    : join(input.artifactRoot, input.ticketId, input.attemptId)
  const stem = `${input.ticketId}--${input.attemptId}`
  const manifestPath = join(out, `${stem}.json`)
  try {
    if (!/^tk-[0-9a-f]{20}$/.test(input.ticketId) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.attemptId)
      || input.attemptId.includes('..')) throw Error('unsafe artifact identity')
    const root = await fso(io).realpath(input.worktree)
    const found = new Map<string, { path: string; bytes: number }>()
    const maxFiles = Math.min(input.maxFiles ?? 5000, 5000)
    const maxBytes = Math.min(input.maxBytes ?? 209_715_200, 209_715_200)
    const walk = async (path: string, rel: string): Promise<void> => {
      const stat = await fso(io).lstat(path)
      if (stat.isSymbolicLink()) { manifest.rejected.push({ path: rel, why: 'link' }); return }
      const real = await fso(io).realpath(path)
      if (!inside(real, root)) { manifest.rejected.push({ path: rel, why: 'outside' }); return }
      if (stat.isFile()) {
        if (!found.has(rel)) {
          found.set(rel, { path: rel, bytes: stat.size })
          manifest.totalBytes += stat.size
        }
      } else if (stat.isDirectory()) {
        for (const name of (await fso(io).readdir(path)).sort()) await walk(join(path, name), rel ? `${rel}/${name}` : name)
      }
    }
    for (const declaration of input.declared) {
      if (!safeDeclaration(declaration)) { manifest.rejected.push({ path: declaration, why: 'unsafe-path' }); continue }
      const directory = declaration.endsWith('/')
      let candidates: { path: string; rel: string }[] = [{ path: input.worktree, rel: '' }]
      for (const segment of declaration.replace(/\/$/, '').split('/')) {
        const next: typeof candidates = []
        for (const candidate of candidates) {
          try {
            const stat = await fso(io).lstat(candidate.path)
            if (stat.isSymbolicLink()) { manifest.rejected.push({ path: candidate.rel, why: 'link' }); continue }
            if (!inside(await fso(io).realpath(candidate.path), root)) {
              manifest.rejected.push({ path: candidate.rel, why: 'outside' }); continue
            }
          } catch (error) { manifest.rejected.push({ path: candidate.rel, why: String(error) }); continue }
          if (segment === '*') {
            try {
              for (const name of await fso(io).readdir(candidate.path)) {
                next.push({ path: join(candidate.path, name), rel: candidate.rel ? `${candidate.rel}/${name}` : name })
              }
            } catch (error) { manifest.rejected.push({ path: candidate.rel, why: String(error) }) }
          } else next.push({ path: join(candidate.path, segment), rel: candidate.rel ? `${candidate.rel}/${segment}` : segment })
        }
        candidates = next
      }
      for (const candidate of candidates) {
        try {
          const stat = await fso(io).lstat(candidate.path)
          if (directory && !stat.isDirectory() && !stat.isSymbolicLink()) {
            manifest.rejected.push({ path: candidate.rel, why: 'not-directory' }); continue
          }
          await walk(candidate.path, candidate.rel)
        } catch (error) { manifest.rejected.push({ path: candidate.rel, why: String(error) }) }
      }
    }
    const sorted = [...found.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    manifest.files = sorted.slice(0, maxFiles)
    if (sorted.length > maxFiles) manifest.truncated = true
    if (manifest.totalBytes > maxBytes || sorted.length > maxFiles) manifest.state = 'listed'
    else {
      const entries: { path: string; body: Buffer }[] = []
      for (const item of sorted) {
        const path = join(input.worktree, item.path)
        const stat = await fso(io).lstat(path)
        if (stat.isSymbolicLink() || !inside(await fso(io).realpath(path), root)) {
          manifest.rejected.push({ path: item.path, why: 'link-or-outside' }); continue
        }
        entries.push({ path: item.path, body: await fso(io).readFile(path) })
      }
      const body = await zipEntries(entries, io)
      await fso(io).mkdir(out, { recursive: true })
      const zip = `${stem}.zip`
      await publish(join(out, zip), body, io)
      manifest.state = 'zipped'; manifest.zip = zip; manifest.zipBytes = body.length
    }
    await fso(io).mkdir(out, { recursive: true })
    await publish(manifestPath, JSON.stringify(manifest), io)
    return manifest
  } catch (error) {
    manifest.state = 'failed'; manifest.detail = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    delete manifest.zip; delete manifest.zipBytes
    try { await fso(io).mkdir(out, { recursive: true }); await publish(manifestPath, JSON.stringify(manifest), io) }
    catch { /* manifest best effort */ }
    return manifest
  }
}
