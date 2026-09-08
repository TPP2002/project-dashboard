/**
 * 对已经派出的 Codex 工单续聊(CODEX-CHAT-BOARD,2026-09-01)。
 *
 * 【定位】只负责三件紧挨着的事:从原事件流收起 thread_id、拼出 CLI 0.151 支持的
 * resume 参数、同步发一条消息并把问答追加到本机证据。看板只调用这里的公开契约，
 * 不需要知道 Codex 二进制在哪、旧工单怎样兼容，也不会在两个入口各长一套续聊逻辑。
 *
 * 【安全默认】续聊默认 read-only。插话最常见的是追问和补充说明；需要让会话继续写代码时，
 * 调用方必须显式传 sandbox，不能因为原工单可写就悄悄继承写权限。
 *
 * 【为什么续聊要回写 last-message.json】resume 不接 --output-schema 也不接 -o，新结论只落在 stdout；
 * 而 collect 判卷读的是 last-message.json。不回写的后果是「续聊补做完了、机器验收全绿，判决却还停在
 * 续聊前那句 blocked 和那批旧 openQuestions」（0908 wf-zoom / aud-hooks-dedup 两单实测）。
 * 所以这里在回话里认一份**符合 verdict schema 的 JSON**，认到才覆盖，认不到一个字都不动 ——
 * 宁可继续用旧自述（现状，人已经知道要怎么读），也不能拿一段散文把结论文件糊掉。
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isValidSlug } from './codex-contract'
import { jobPaths, REPO_ROOT } from './codex-paths'
import { resolveCodexBin } from './codex-runner'
import { VERDICT_SCHEMA } from './codex-verdict'

interface SayResult {
  ok: boolean
  threadId: string | null
  reply: string | null
  exitCode: number | null
  /** 这次回话有没有刷新工单的自述结论(last-message.json)。false = collect 还会按续聊前那份判。 */
  reportRefreshed: boolean
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


/**
 * 把一段文本里所有**括号配平**的顶层 `{...}` 片段切出来,按出现顺序返回。
 *
 * 【为什么不能照抄 parseSelfReport 的"第一个 { 到最后一个 }"】那招在 `-o` 写出的
 * last-message.json 上够用(整份文件基本就是一个 JSON);但 resume 的 stdout 是给人看的:
 * 前面有版本号/工作目录/沙箱模式的表头,中间原样回显我们发过去的那句话,后面还有 token 计数。
 * 只要这些噪音里出现一个花括号,"掐头去尾"就会切出一段废字符串,结论当场认不出来。
 * 逐字符扫描配平(且跳过字符串字面量里的括号)是这里唯一稳的做法。
 */
export const jsonObjectSlices = (raw: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** 结论 JSON 的必填字段与状态枚举,直接取自下发给 Codex 的那份 schema —— 只有一处口径。 */
const VERDICT_REQUIRED_KEYS: readonly string[] = VERDICT_SCHEMA.required
const VERDICT_STATUSES: readonly string[] = VERDICT_SCHEMA.properties.status.enum

/** 判它是不是一份**完整**的结论,而不是回话里碰巧出现的某个 JSON 片段。 */
const isVerdictShaped = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  if (!VERDICT_REQUIRED_KEYS.every((key) => key in obj)) return false
  if (typeof obj.status !== 'string' || !VERDICT_STATUSES.includes(obj.status)) return false
  if (typeof obj.summary !== 'string') return false
  return ['changedFiles', 'acceptanceResults', 'openQuestions', 'blockers'].every((key) => Array.isArray(obj[key]))
}

/**
 * 从续聊回话里认出那份新结论,认到就把原文片段交出来(不重新序列化 —— 结论是证据,留它自己的字)。
 *
 * 【为什么卡这么严】认错的代价是不对称的:漏认一次,collect 继续按旧自述判,人早就知道要怎么读
 * (开工须知里写着);认错一次,却是拿一段散文把工单唯一的结论文件覆盖掉,证据就没了。
 * 所以必填字段少一个、status 不在枚举里、数组字段不是数组 —— 一律不算,当没认出来。
 * 从后往前找:回话最后那份才是它这一轮的最终结论,前面可能还回顾了上一轮的结论。
 */
export const extractVerdictJson = (raw: string): string | null => {
  if (!raw || !raw.trim()) return null
  const candidates = [raw.trim(), ...jsonObjectSlices(raw)]
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = (candidates[i] as string).trim()
    try {
      if (isVerdictShaped(JSON.parse(candidate))) return candidate
    } catch {
      // 不是 JSON 就换下一个候选,回话里夹的散文本来就解析不了。
    }
  }
  return null
}

/**
 * 在 state.json 上补记续聊时刻。state.json 读不出来就不写 —— 它装着 pid / 退出码 / 超时,
 * 判决要靠它区分"崩了"和"跑完没打标记";为了记一个时间戳把这些覆盖成空,得不偿失。
 * 少一条时间戳只是 collect 少印一行来源,结论本身照样是最新的。
 */
const recordResume = (statePath: string, at: string, reportRefreshed: boolean): void => {
  if (!existsSync(statePath)) return
  let prev: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    prev = parsed as Record<string, unknown>
  } catch {
    return
  }
  const next = {
    ...prev,
    resumedAt: at,
    selfReportUpdatedAt: reportRefreshed ? at : (prev.selfReportUpdatedAt ?? null),
  }
  writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
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

export const sayToJob = (slug: string, message: string, opts?: { sandbox?: string }): SayResult => {
  const rejected = (error: string): SayResult => ({
    ok: false,
    threadId: null,
    reply: null,
    exitCode: null,
    reportRefreshed: false,
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
    return { ok: false, threadId, reply: null, exitCode, reportRefreshed: false, error: result.error.message }
  }

  try {
    appendExchange(paths.chatLog, message, reply)
  } catch (err) {
    return {
      ok: false,
      threadId,
      reply,
      exitCode,
      reportRefreshed: false,
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
      reportRefreshed: false,
      error: stderr || 'codex exec resume 退出码 ' + String(exitCode),
    }
  }

  // 只有跑成功的这一轮才有资格改结论:退出码非零时那段 stdout 是半截话,不能拿它当新自述。
  const fresh = extractVerdictJson(reply)
  const at = new Date().toISOString()
  if (fresh) {
    try {
      writeFileSync(paths.lastMessage, fresh + '\n', 'utf8')
    } catch (err) {
      recordResume(paths.state, at, false)
      return {
        ok: false,
        threadId,
        reply,
        exitCode,
        reportRefreshed: false,
        error:
          '续聊拿到了新结论,但 last-message.json 写不进去:' + (err as Error).message +
          ' —— 不处理的话 collect 还会按续聊前那份判。',
      }
    }
  }
  recordResume(paths.state, at, Boolean(fresh))

  return { ok: true, threadId, reply, exitCode, reportRefreshed: Boolean(fresh) }
}
