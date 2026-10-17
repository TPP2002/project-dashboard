/** T-pre 原生宿主的异步端口。请求在独立宿主串行执行，Node 心跳与代理主循环不等同步子进程。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { nativeSources } from './sched-suspend-native-assets'
import type { SuspendAction } from './sched-suspend-store'
import type { PermitAuthority } from './sched-permit-authority'

export interface TreeMember { pid: number; creationFileTime: string; error?: string | null }
export interface TreeLaunch {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; directory: string; at: number
  recordHost: (host: TreeMember) => void
  permitAuthority?: PermitAuthority
}
export interface NativeTree {
  launch(input: TreeLaunch): Promise<{ root: TreeMember; host: TreeMember }>
  release(): Promise<void>
  members(): Promise<TreeMember[]>
  act(action: SuspendAction, member: TreeMember, operationId: number): Promise<{ status: string; detail?: unknown }>
  check(action: SuspendAction, member: TreeMember, operationId: number): Promise<{ confirmed: boolean; detail?: unknown }>
  poll(): Promise<{ empty: boolean; exitCode: number | null }>
  kill(): Promise<void>
  close(): Promise<void>
}
/**
 * 原生单请求超时阈值(负责人 0924 拍板【五】,具名不再散落):帮手单请求超过它即判『拿不准』,
 * 由控制端按只读/改状态归类处置;关闭宿主的确认等待同预算。
 */
export const NATIVE_REQUEST_TIMEOUT_MS = 12_000
/** 只读原生请求(0924 拍板【三】按抛错的原生调用归类):查成员表/线程状态/退出状态——失败不触发冻结。 */
const READONLY_NATIVE_KINDS: readonly string[] = ['members', 'check', 'poll']
/** 失败归类标记:挂在原生端口抛出的错误对象上,控制端据此区分只读查询失败与改状态调用失败。 */
export interface NativeFailureTag { nativeRequestKind?: string; nativeHostUnavailable?: boolean }
/** 构造带请求用途标记的原生失败;超时与宿主报错同款,测试注入假帮手也用它保持归类一致。 */
export function nativeRequestFailure(message: string, kind: string): Error & NativeFailureTag {
  return Object.assign(new Error(message), { nativeRequestKind: kind })
}
/** 宿主整体不可用(退出/管道断裂/尚未启动):不挑请求,按改状态一档先冻结再等恢复。 */
function hostUnavailableFailure(message: string): Error & NativeFailureTag {
  return Object.assign(new Error(message), { nativeHostUnavailable: true })
}
/** 只读查询失败(members/check/poll 超时或宿主对其报错):不触发冻结,告警一次,下一拍再查。 */
export function isReadonlyNativeFailure(error: unknown): boolean {
  const kind = (error as NativeFailureTag)?.nativeRequestKind
  return typeof kind === 'string' && READONLY_NATIVE_KINDS.includes(kind)
}
/** 改状态原生调用失败(挂起/恢复/降速/终止等):先冻结保护,再重新核实后决定下一步。 */
export function isMutatingNativeFailure(error: unknown): boolean {
  const kind = (error as NativeFailureTag)?.nativeRequestKind
  return typeof kind === 'string' && !READONLY_NATIVE_KINDS.includes(kind)
}
/** 帮手整体不可用:拿不准,先冻结保护再等恢复;连续超限由控制端升级交人工。 */
export function isHostUnavailableFailure(error: unknown): boolean {
  return (error as NativeFailureTag)?.nativeHostUnavailable === true
}
/** T-pre tree-ctl.cjs 7d51ada3849c 的 CRT 引号规则；不经 shell 解释用户参数。 */
export function quoteWindows(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}
function executable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const roots = /[\\/]/.test(command) ? [''] : [cwd, ...(env.PATH ?? process.env.PATH ?? '').split(delimiter)]
  for (const root of roots) {
    const base = resolve(root || cwd, command)
    for (const name of [base, `${base}.exe`]) if (/\.exe$/i.test(name) && existsSync(name)) return name
  }
  throw new Error(`[sched] 找不到可执行文件:${command}；批处理请显式经 cmd.exe 启动`)
}

export function createNativeTree(): NativeTree {
  let child: ChildProcessWithoutNullStreams | undefined, sequence = 0, dead: Error | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; kind: string }>()
  const fail = (cause: Error): void => {
    // 抹掉原始错误对象换带标记的同文错误:宿主级失败不挑请求,一律按改状态一档先冻结再等恢复。
    dead = hostUnavailableFailure(cause.message)
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(dead) }
    pending.clear()
  }
  const request = <T>(kind: string, data: Record<string, unknown> = {}): Promise<T> => new Promise((resolveRequest, reject) => {
    if (dead || !child) { reject(dead ?? hostUnavailableFailure('[sched] 原生宿主尚未启动')); return }
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id); reject(nativeRequestFailure(`[sched] 原生请求超时:${kind}；状态未确认，保持挂起并告警`, kind))
    }, NATIVE_REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve: value => resolveRequest(value as T), reject, timer, kind })
    child.stdin.write(JSON.stringify({ id, kind, ...data }) + '\n', error => { if (error) fail(error) })
  })
  return {
    launch: async input => {
      if (process.platform !== 'win32') throw new Error('[sched] 作业对象挂起只支持 Windows，拒绝退回父子链方案')
      // SCHED-RUN-LAUNCH-EDGE-GAPS ①:先把命令解析成可执行文件,再写目录、起 PowerShell 宿主——
      // 命令不存在时在动任何系统资源之前原样抛出,不白起一次宿主,也不让关闭宿主的 12 秒等待盖掉真正的启动错误。
      const exe = executable(input.command, input.cwd, input.env)
      mkdirSync(input.directory, { recursive: true })
      for (const [name, source] of Object.entries(nativeSources)) writeFileSync(join(input.directory, name), '\ufeff' + source.replace(/^\ufeff/, ''))
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        join(input.directory, '进程树控制宿主.ps1')], { windowsHide: true, env: input.env, stdio: 'pipe' })
      child.once('error', fail); child.once('close', () => fail(new Error('[sched] 原生宿主已退出，执行树随句柄关闭终止')))
      child.stdin.on('error', fail)
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
      child.once('exit', code => { if (code) fail(new Error(`[sched] 原生宿主退出 ${code}:${stderr}`)) })
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const reply = JSON.parse(line) as { id: number; value: unknown; error?: string }
          const entry = pending.get(reply.id)
          if (!entry) return
          pending.delete(reply.id); clearTimeout(entry.timer)
          if (reply.error) entry.reject(nativeRequestFailure(reply.error, entry.kind)); else entry.resolve(reply.value)
        } catch (error) { fail(new Error(`[sched] 原生响应非法:${String(error)}`)) }
      })
      // 宿主身份先刷入控制端记录，再允许发送 launch。此前死亡没有执行树，此后可核对宿主关闭。
      const host = await request<TreeMember>('identity')
      if (host.error || !host.creationFileTime) throw new Error('[sched] 原生宿主身份无法确认')
      input.recordHost(host)
      return request('launch', { exe, commandLine: [exe, ...input.args].map(quoteWindows).join(' '), cwd: input.cwd,
        dir: input.directory, at: input.at, ...(input.permitAuthority ? { permitAuthority: input.permitAuthority } : {}) })
    },
    release: () => request('release'), members: () => request('members'),
    act: (action, member, operationId) => request('act', { action, member, operationId }),
    check: (action, member, operationId) => request('check', { action, member, operationId }),
    poll: () => request('poll'), kill: () => request('kill'),
    close: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const host = child
      await new Promise<void>((resolveClose, reject) => {
        const timer = setTimeout(() => reject(hostUnavailableFailure('[sched] 关闭宿主尚未确认，保留离线记录')), NATIVE_REQUEST_TIMEOUT_MS)
        host.once('close', () => { clearTimeout(timer); resolveClose() })
        host.stdin.end()
      })
    },
  }
}
