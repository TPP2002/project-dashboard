/**
 * 对已经派出的 Codex 工单续聊(CODEX-CHAT-BOARD,2026-09-01)。
 *
 * 【定位】只负责三件紧挨着的事:从原事件流收起 thread_id、拼出 CLI 0.151 支持的
 * resume 参数、同步发一条消息并把问答追加到本机证据。看板只调用这里的公开契约，
 * 不需要知道 Codex 二进制在哪、旧工单怎样兼容，也不会在两个入口各长一套续聊逻辑。
 *
 * 【安全默认】续聊默认 read-only。插话最常见的是追问和补充说明；需要让会话继续写代码时，
 * 调用方必须显式传 sandbox，不能因为原工单可写就悄悄继承写权限。
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isValidSlug } from './codex-contract'
import { jobPaths, REPO_ROOT } from './codex-paths'
import { resolveCodexBin } from './codex-runner'

interface SayResult {
  ok: boolean
  threadId: string | null
  reply: string | null
  exitCode: number | null
  error?: string
}

const EXEC_LOG_PREFIX_BYTES = 64 * 1024

/**
 * 从 codex exec --json 开头 64KB 的逐行事件里拿第一条 thread.started。
 * 真实日志开头可能夹纯文本诊断行，所以单行坏 JSON 只跳过，不能让整份日志失效。
 * 会话号本应出现在开头；前缀里没有就返回 null，不扫描可能有几十兆的剩余事件流。
 */
export const extractThreadId = (execLogPath: string): string | null => {
  if (!existsSync(execLogPath)) return null

  let content: string
  try {
    const fd = openSync(execLogPath, 'r')
    try {
      const prefix = Buffer.alloc(EXEC_LOG_PREFIX_BYTES)
      const bytesRead = readSync(fd, prefix, 0, prefix.length, 0)
      content = prefix.toString('utf8', 0, bytesRead)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }

  for (const line of content.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0) {
        return event.thread_id
      }
    } catch {
      // exec.jsonl 允许夹 Codex 自己写到 stderr 的纯文本，继续找下一行。
    }
  }
  return null
}

/** resume 不支持 --cd / --sandbox；沙箱只能经配置覆盖传入。 */
export const buildResumeArgs = (threadId: string, message: string, sandbox: string): string[] => [
  'exec',
  'resume',
  threadId,
  message,
  '--skip-git-repo-check',
  '-c',
  'sandbox_mode="' + sandbox + '"',
]

export interface SayArgs {
  slug: string | null
  message: string | null
  messageFile: string | null
  sandbox: string | null
  error: string | null
}

/**
 * 解析 say 的参数：位置参数 = slug、消息；选项 --sandbox / --message-file 放哪都行。
 * Windows 下 `npx tsx` 经 cmd 垫片转发，argv 在第一个换行处被截断，多行消息一律走 --message-file。
 */
export const parseSayArgs = (args: string[]): SayArgs => {
  const out: SayArgs = { slug: null, message: null, messageFile: null, sandbox: null, error: null }
  const positionals: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--sandbox' || a === '--message-file') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) { out.error = a + ' 后面要跟值'; return out }
      if (a === '--sandbox') out.sandbox = v
      else out.messageFile = v
      i += 1
      continue
    }
    if (a.startsWith('--')) { out.error = '不认识的选项 ' + a; return out }
    positionals.push(a)
  }
  out.slug = positionals[0] ?? null
  out.message = positionals[1] ?? null
  if (!out.slug) out.error = '缺 slug'
  else if (!out.message && !out.messageFile) out.error = '缺消息：直接写一句，或用 --message-file 指一个文本文件（多行消息只能走文件）'
  else if (out.message && out.messageFile) out.error = '消息和 --message-file 只能给一个'
  return out
}

/** 消息正文：文件优先（多行、含引号都不怕）；去掉 CR，首尾空白剪掉。 */
export const readSayMessage = (args: SayArgs): string => {
  const raw = args.messageFile ? readFileSync(args.messageFile, 'utf8') : (args.message ?? '')
  return raw.replace(/\r/g, '').trim()
}

/** 续聊要回到这单原来的工作目录：--worktree 派出去的单在隔离工作区里干活，若在主工位里 resume，Codex 沙箱会把工作区当「项目外目录」拒写。 */
export const cwdFromMeta = (metaPath: string): string | null => {
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { cwd?: unknown }
    return typeof meta.cwd === 'string' && meta.cwd.length > 0 && existsSync(meta.cwd) ? meta.cwd : null
  } catch {
    return null
  }
}

const threadIdFromState = (statePath: string): string | null => {
  if (!existsSync(statePath)) return null
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { threadId?: unknown }
    return typeof state.threadId === 'string' && state.threadId.length > 0 ? state.threadId : null
  } catch {
    return null
  }
}

const appendExchange = (chatLogPath: string, message: string, reply: string): void => {
  const lines = [
    { at: new Date().toISOString(), direction: 'out' as const, text: message },
    { at: new Date().toISOString(), direction: 'in' as const, text: reply },
  ]
  appendFileSync(chatLogPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

export const sayToJob = (
  slug: string,
  message: string,
  opts?: { sandbox?: string },
): { ok: boolean; threadId: string | null; reply: string | null; exitCode: number | null; error?: string } => {
  const rejected = (error: string): SayResult => ({
    ok: false,
    threadId: null,
    reply: null,
    exitCode: null,
    error,
  })

  if (!isValidSlug(slug)) return rejected('slug 非法:只许小写字母数字连字符、2~49 字符')
  if (!message.trim()) return rejected('消息不能为空或只含空白')

  const paths = jobPaths(slug)
  const threadId = threadIdFromState(paths.state) ?? extractThreadId(paths.execLog)
  if (!threadId) return rejected('找不到这个工单的会话号(threadId),工单可能尚未启动或旧日志不完整')

  let codexBin: string
  try {
    codexBin = resolveCodexBin()
  } catch (err) {
    return { ...rejected((err as Error).message), threadId }
  }

  const result = spawnSync(codexBin, buildResumeArgs(threadId, message, opts?.sandbox ?? 'read-only'), {
    cwd: cwdFromMeta(paths.meta) ?? REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const exitCode = result.status ?? null
  const reply = result.stdout ?? ''

  if (result.error) {
    return { ok: false, threadId, reply: null, exitCode, error: result.error.message }
  }

  try {
    appendExchange(paths.chatLog, message, reply)
  } catch (err) {
    return {
      ok: false,
      threadId,
      reply,
      exitCode,
      error: '续聊进程已返回,但 chat.jsonl 落盘失败:' + (err as Error).message,
    }
  }

  if (exitCode !== 0) {
    const stderr = (result.stderr ?? '').trim()
    return {
      ok: false,
      threadId,
      reply,
      exitCode,
      error: stderr || 'codex exec resume 退出码 ' + String(exitCode),
    }
  }

  return { ok: true, threadId, reply, exitCode }
}
