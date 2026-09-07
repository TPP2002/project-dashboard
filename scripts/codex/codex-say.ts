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
    cwd: REPO_ROOT,
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
