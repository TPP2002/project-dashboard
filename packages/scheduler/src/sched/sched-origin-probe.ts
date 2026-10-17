import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from 'node:child_process'

export const ORIGIN_PROBE_BATCH_MAX = 32
export const ORIGIN_PROBE_TIMEOUT_MS = 10_000
export const ORIGIN_PROBE_MAX_BUFFER = 1_048_576
export const ORIGIN_SELF_RETRY_MS = 60_000
const SID = /^S-1-[0-9]+(-[0-9]+)+$/

export const ORIGIN_SELF_SCRIPT = [
  '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
  'if ($identity.User -and $identity.User.Value) { [Console]::Out.WriteLine((\'SELF \' + $identity.User.Value)) }',
  'if ($identity.Owner -and $identity.Owner.Value) { [Console]::Out.WriteLine((\'SELF \' + $identity.Owner.Value)) }',
  '[Console]::Out.WriteLine(\'DONE 0\')',
].join('\n')
export const ORIGIN_PROBE_SCRIPT = [
  '$paths = [Environment]::GetEnvironmentVariable(\'SCHED_ORIGIN_PATHS\').Split([char]10)',
  'for ($i = 0; $i -lt $paths.Length; $i++) {',
  '  try {',
  '    $sid = (Get-Acl -LiteralPath $paths[$i]).GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
  '    [Console]::Out.WriteLine((\'OWNER \' + $i + \' \' + $sid))',
  '  } catch { [Console]::Out.WriteLine((\'ERROR \' + $i + \' \' + $_.Exception.GetType().Name)) }',
  '}',
  '[Console]::Out.WriteLine((\'DONE \' + $paths.Length))',
].join('\n')

export type OriginProbeExecutor = (
  command: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => { kill?: () => unknown } | void
export type OriginProbeRequest = { ticketId: string; attemptId: string; path: string }
export type OriginProbeResult =
  | { ticketId: string; attemptId: string; verdict: 'owner'; ownerSid: string; trusted: boolean }
  | { ticketId: string; attemptId: string; verdict: 'failed'; detail: string }
export interface OriginProbe {
  request(items: readonly OriginProbeRequest[]): void
  pump(): void
  take(): OriginProbeResult[]
  inFlight(): number
  close(): void
}
const failed = (item: OriginProbeRequest, detail: string): OriginProbeResult => ({
  ticketId: item.ticketId, attemptId: item.attemptId, verdict: 'failed', detail,
})
const lines = (stdout: string): string[] => stdout.split(/\r?\n/).filter(line => line.length > 0)

export function parseOriginSelfOutput(stdout: string): string[] | null {
  const own = new Set<string>()
  let done = 0
  for (const line of lines(stdout)) {
    if (line === 'DONE 0') { done++; continue }
    const match = /^SELF (\S+)$/.exec(line)
    if (!match || !SID.test(match[1]!)) return null
    own.add(match[1]!)
  }
  return done === 1 && own.size > 0 ? [...own].sort() : null
}
export function parseOriginProbeOutput(stdout: string, batch: readonly OriginProbeRequest[], self: ReadonlySet<string>): OriginProbeResult[] {
  const observed: string[][] = batch.map(() => [])
  let done = 0
  for (const line of lines(stdout)) {
    const complete = /^DONE (\d+)$/.exec(line)
    if (complete) { if (Number(complete[1]) === batch.length) done++; else return batch.map(item => failed(item, 'incomplete')); continue }
    const match = /^(OWNER|ERROR) (\d+) (\S+)$/.exec(line)
    if (match) {
      const index = Number(match[2])
      if (index >= 0 && index < batch.length) observed[index]!.push(`${match[1]} ${match[3]}`)
    }
  }
  if (done !== 1) return batch.map(item => failed(item, 'incomplete'))
  return batch.map((item, index) => {
    const entries = observed[index]!
    if (entries.length !== 1) return failed(item, 'owner-missing')
    const owner = /^OWNER (\S+)$/.exec(entries[0]!)
    if (owner && SID.test(owner[1]!)) return { ticketId: item.ticketId, attemptId: item.attemptId,
      verdict: 'owner', ownerSid: owner[1]!, trusted: self.has(owner[1]!) }
    const error = /^ERROR (\S+)$/.exec(entries[0]!)
    return error ? failed(item, `owner:${error[1]}`) : failed(item, 'owner-missing')
  })
}

function errorDetail(error: ExecFileException): string {
  if (error.killed) return 'timeout'
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'maxbuffer'
  if (typeof error.code === 'number') return `exit:${error.code}`
  return `spawn:${error.code ?? error.name}`
}
function thrownDetail(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown }
  return `spawn:${typeof value?.code === 'string' ? value.code : typeof value?.name === 'string' ? value.name : 'Error'}`
}

export function createOriginProbe(options: {
  platform?: NodeJS.Platform; execFile?: OriginProbeExecutor; env?: NodeJS.ProcessEnv;
  log?: (message: string) => void; now?: () => number
} = {}): OriginProbe {
  const platform = options.platform ?? process.platform
  const execute: OriginProbeExecutor = options.execFile ?? execFile
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const clock = (): number => { try { return now() } catch { return 0 } }
  const queue: OriginProbeRequest[] = []
  const results: OriginProbeResult[] = []
  const seen = new Set<string>()
  const warned = new Set<string>()
  let self: ReadonlySet<string> | null = null
  let lastSelfFailure: number | null = null
  let active: ReturnType<OriginProbeExecutor>
  let flying = false
  let closed = false
  const key = (item: Pick<OriginProbeRequest, 'ticketId' | 'attemptId'>) => `${item.ticketId}\u0000${item.attemptId}`
  const warn = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    try { options.log?.(`[sched] 所有者探测:${message}`) } catch { /* 日志端口不得中断节拍 */ }
  }
  const finishBatch = (batch: readonly OriginProbeRequest[], value: OriginProbeResult[]): void => {
    const complete = value.length === batch.length ? value : batch.map(item => failed(item, 'parse'))
    for (const item of complete) {
      results.push(item)
      if (item.verdict === 'failed') warn(`batch:${item.detail}`)
    }
  }
  const api: OriginProbe = {
    request(items) {
      if (closed) return
      for (const item of items) {
        const identity = key(item)
        if (seen.has(identity)) continue
        seen.add(identity)
        if (!/^[\x20-\x7e]+$/.test(item.path)) results.push(failed(item, 'non-ascii-path'))
        else queue.push(item)
      }
    },
    pump() {
      try {
        if (closed || flying || queue.length === 0) return
        if (platform !== 'win32') {
          results.push(...queue.splice(0).map(item => failed(item, 'non-win32')))
          return
        }
        if (self === null) {
          if (lastSelfFailure !== null && clock() - lastSelfFailure < ORIGIN_SELF_RETRY_MS) return
          flying = true
          try {
            active = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ORIGIN_SELF_SCRIPT],
              { encoding: 'utf8', timeout: ORIGIN_PROBE_TIMEOUT_MS, maxBuffer: ORIGIN_PROBE_MAX_BUFFER,
                windowsHide: true, env }, (error, stdout) => {
                flying = false; active = undefined
                if (closed) return
                try {
                  const parsed = error ? null : parseOriginSelfOutput(stdout)
                  if (!parsed) { lastSelfFailure = clock(); warn(`self:${error ? errorDetail(error) : 'parse'}`) }
                  else { self = new Set(parsed); lastSelfFailure = null; warned.clear() }
                } catch { lastSelfFailure = clock(); warn('self:parse') }
                api.pump()
              })
          } catch (error) { flying = false; active = undefined; lastSelfFailure = clock(); warn(`self:${thrownDetail(error)}`) }
          return
        }
        const batch = queue.splice(0, ORIGIN_PROBE_BATCH_MAX)
        flying = true
        try {
          active = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ORIGIN_PROBE_SCRIPT],
            { encoding: 'utf8', timeout: ORIGIN_PROBE_TIMEOUT_MS, maxBuffer: ORIGIN_PROBE_MAX_BUFFER,
              windowsHide: true, env: { ...env, SCHED_ORIGIN_PATHS: batch.map(item => item.path).join('\n') } },
            (error, stdout) => {
              flying = false; active = undefined
              if (closed) return
              try { finishBatch(batch, error ? batch.map(item => failed(item, errorDetail(error)))
                : parseOriginProbeOutput(stdout, batch, self!)) }
              catch { finishBatch(batch, batch.map(item => failed(item, 'parse'))) }
              api.pump()
            })
        } catch (error) { flying = false; active = undefined; finishBatch(batch, batch.map(item => failed(item, thrownDetail(error)))); api.pump() }
      } catch (error) { flying = false; warn(`internal:${thrownDetail(error)}`) }
    },
    take() {
      const taken = results.splice(0).sort((a, b) => a.ticketId.localeCompare(b.ticketId) || a.attemptId.localeCompare(b.attemptId))
      for (const item of taken) seen.delete(key(item))
      return taken
    },
    inFlight() { return flying ? 1 : 0 },
    close() { closed = true; queue.length = 0; results.length = 0; try { if (active && active.kill) active.kill() } catch { /* 关闭时不抛 */ } },
  }
  return api
}
