/**
 * herdr 外壳:把派出去的活挂进一个能看着的终端窗格(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】**可选件**。不装 herdr,派单器照常工作;装了 herdr,才多出"看着它干活"这件事。
 * herdr 是给 AI agent 用的终端复用器(tmux 的同类),本文件只用它两个能力:
 * 开一个不抢焦点的窗格、往窗格里塞一条命令。
 *
 * 【为什么不把 Codex 的交互 TUI 直接塞进窗格】那是网上教程的常见做法,在本机行不通:
 * herdr 在 Windows 上走 ConPTY,CJK 宽度算法与 POSIX 不同,中文 TUI 会糊版;
 * 而本仓库满屏中文。所以这里跟的是**派单器落盘的事件流**(纯文本行),
 * 不受宽度问题影响 —— 代价是没有 herdr 的状态灯,那个由 collect 的判决顶上。
 *
 * 【为什么所有调用都容错】herdr 没装、没起服务、版本对不上,都**不该让派单失败**。
 * 派单是主线,看不看得见是锦上添花。任何一步不顺就打一行提示走人。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { jobPaths } from './codex-paths'
import { isValidSlug } from './codex-contract'

const IS_WIN = process.platform === 'win32'

/** 找 herdr 可执行文件;找不到返回 null(不抛错——它是可选件)。 */
export const resolveHerdrBin = (): string | null => {
  const fromEnv = process.env.HERDR_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const probe = spawnSync(IS_WIN ? 'where' : 'which', ['herdr'], { encoding: 'utf8' })
  const found = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (found && existsSync(found)) return found

  if (IS_WIN && process.env.LOCALAPPDATA) {
    const fallback = join(process.env.LOCALAPPDATA, 'Programs', 'herdr', 'bin', 'herdr.exe')
    if (existsSync(fallback)) return fallback
  }
  return null
}

export interface HerdrProbe {
  bin: string | null
  serverRunning: boolean
  hint: string
}

/** 探一次 herdr 的死活,顺带给出该怎么办的一句话。 */
export const probeHerdr = (): HerdrProbe => {
  const bin = resolveHerdrBin()
  if (!bin) {
    return {
      bin: null,
      serverRunning: false,
      hint: 'herdr 没装(可选件,不装不影响派单)。装法见 docs/开工须知-Codex派单.md 第 7 节。',
    }
  }
  const status = spawnSync(bin, ['status'], { encoding: 'utf8' })
  const running = /status:\s*running/.test(status.stdout || '')
  return {
    bin,
    serverRunning: running,
    hint: running ? 'herdr 服务在跑。' : 'herdr 装了但服务没起。先跑一次:herdr server(后台常驻,不需要 TUI)。',
  }
}

/**
 * 给某个工单开一个跟日志的窗格。
 * 返回 pane_id;开不出来返回 null 并打一行原因,**绝不抛错**。
 */
export const openWatchPane = (slug: string): string | null => {
  const probe = probeHerdr()
  if (!probe.bin || !probe.serverRunning) {
    process.stdout.write('  (没在 herdr 里开窗格:' + probe.hint + ')\n')
    return null
  }

  // slug 会被拼进下面那条 shell 命令。走 parseTask 的路径早卡过一次,
  // 但 `watch <slug>` 是从 argv 直接拿的 —— 不在这里再卡一道,一个带引号的 slug
  // 就能从 PowerShell 的单引号串里逃出来。
  if (!isValidSlug(slug)) {
    process.stdout.write('  (slug 不合法,不开窗格:只许小写字母数字连字符)\n')
    return null
  }
  const paths = jobPaths(slug)
  if (!existsSync(paths.execLog)) {
    process.stdout.write('  (没有这一单的事件流,不开窗格:' + slug + ')\n')
    return null
  }
  // 跟事件流用各平台自带的"追加跟随",不引第三方工具。
  const follow = IS_WIN
    ? 'powershell -NoProfile -Command "Get-Content -Wait -Tail 40 -LiteralPath \'' + paths.execLog + '\'"'
    : "tail -f -n 40 '" + paths.execLog + "'"

  const created = spawnSync(probe.bin, ['tab', 'create', '--label', 'codex:' + slug, '--no-focus'], {
    encoding: 'utf8',
  })
  if (created.status !== 0) {
    process.stdout.write('  (herdr 开标签页失败,不影响派单:' + (created.stderr || '').trim() + ')\n')
    return null
  }

  // tab create 的返回里带着这个标签页的根窗格 id,直接拿来塞命令。
  let paneId: string | null
  try {
    const parsed = JSON.parse(created.stdout) as { result?: { root_pane?: { pane_id?: string } } }
    paneId = parsed.result?.root_pane?.pane_id ?? null
  } catch {
    paneId = null
  }
  if (!paneId) {
    process.stdout.write('  (herdr 没回窗格 id,跳过)\n')
    return null
  }

  const ran = spawnSync(probe.bin, ['pane', 'run', paneId, follow], { encoding: 'utf8' })
  if (ran.status !== 0) {
    process.stdout.write('  (herdr 塞命令失败:' + (ran.stderr || '').trim() + ')\n')
    return null
  }

  process.stdout.write('  👀 herdr 窗格 ' + paneId + '(标签页 codex:' + slug + ')正在跟这一单的事件流\n')
  return paneId
}
