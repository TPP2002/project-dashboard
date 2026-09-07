/**
 * 起 codex exec 进程、落盘、收证据(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】整套桥里唯一碰进程和文件系统的地方。契约(codex-contract)和判决(codex-verdict)
 * 都是纯函数,IO 全压在本文件,是为了让那两处能被单测钉死 —— 判决规则一旦要靠起真进程
 * 才能验证,就等于没有验证。
 *
 * 【为什么派出去是"后台 detached"而不是同步等】负责人是总控模式,一次要开十几路活。
 * 同步等 = Claude 主循环被一个 Codex 占住,派单变保姆;而且订阅额度按时间窗滚动作废,
 * 串行派一个等一个,窗口白白流走。所以 dispatch 起完就走,collect 另行判读。
 *
 * 【为什么改动清单要减基线】Codex 被禁止做任何 git 写操作(见 codex-prompt),
 * 产出永远停在工作区。但工作区在派单时刻可能本来就脏(别的会话的未提交改动),
 * 不减基线就会把别人的活算到 Codex 头上,禁区复核直接误判。
 * 用 --worktree 派出去的活是干净工作区,基线为空,最省心。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { CodexTask } from './codex-contract'
import { resolveAcceptanceArgv } from './codex-contract'
import { jobPaths, worktreeFor, REPO_ROOT } from './codex-paths'
import { renderPrompt, completionMarker } from './codex-prompt'
import { extractThreadId } from './codex-say'
import { VERDICT_SCHEMA, type MachineAcceptance } from './codex-verdict'

const IS_WIN = process.platform === 'win32'

/**
 * 找 codex 可执行文件。
 *
 * 【为什么不能"找到一个就用"】Windows 桌面版 Codex 自升级时会在
 * `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe` 下放新件,而 `bin\codex.exe`
 * 那个顶层旧件**不会被删**。本机实测:顶层是 0.130(5 月),哈希目录里是 0.151(8 月)。
 * 挑到旧件的症状极具迷惑性 —— 它读得懂 `~/.codex/config.toml` 的路径却不认识里面的新键
 * (如 model_reasoning_effort="max"),开局就吐一行
 * `Error loading config.toml: unknown variant`,看着像配置写错了,其实是二进制太老。
 * 所以这里把所有候选摊开,**按修改时间取最新**。
 */
export const resolveCodexBin = (): string => {
  const fromEnv = process.env.CODEX_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates: string[] = []
  const probe = spawnSync(IS_WIN ? 'where' : 'which', ['codex'], { encoding: 'utf8' })
  candidates.push(...(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))

  if (IS_WIN && process.env.LOCALAPPDATA) {
    const binDir = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    if (existsSync(binDir)) {
      candidates.push(join(binDir, 'codex.exe'))
      for (const entry of readdirSync(binDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(binDir, entry.name, 'codex.exe'))
      }
    }
  }

  const [newest] = candidates
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (newest) return newest.path
  throw new Error(
    '[codex-runner] 找不到 codex 可执行文件。装了但不在 PATH 时,用环境变量指过去:\n' +
      '  CODEX_BIN="C:/Users/<你>/AppData/Local/OpenAI/Codex/bin/<哈希>/codex.exe"',
  )
}

/**
 * npm / npx 在 Windows 上是 .cmd 批处理:不带 shell 直接 spawn 会 ENOENT,
 * 带 .cmd 后缀又会撞上 Node 20 的加固(CVE-2024-27980)当场 EINVAL。
 * 唯一能跑的姿势就是走 shell。
 *
 * 【为什么这里走 shell 不构成注入面】argv 全部来自 ACCEPTANCE_KINDS 里写死的模板,
 * 唯一的变量 target 已被契约层的 ^[A-Za-z0-9._/-]+$ 卡过 —— 空格、引号、分号、
 * 反引号、$() 一个都进不来。工单里夹带的 command 字段则被契约层直接无视。
 */
const acceptanceSpawnOptions = (argv: string[]): { cmd: string; args: string[]; shell: boolean } => {
  const [head = '', ...rest] = argv
  if (!IS_WIN) return { cmd: head, args: rest, shell: false }
  const needsShell = head === 'npm' || head === 'npx'
  return { cmd: needsShell ? head + '.cmd' : head, args: rest, shell: needsShell }
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const git = (args: string[], cwd: string): { code: number; out: string } => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, out: (r.stdout || '').replace(/\s+$/, '') }
}

/** 解析 porcelain 状态行；行首两位状态码和其后的分隔位不能先被裁掉。 */
export const parsePorcelain = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ''))

/** 工作区当前的改动清单(未提交的),仓库相对路径。 */
const dirtyFiles = (cwd: string): string[] => {
  const { out } = git(['status', '--porcelain', '--untracked-files=all'], cwd)
  return parsePorcelain(out)
}

export interface JobMeta {
  slug: string
  taskId: string
  taskHash: string
  dispatchedAt: string
  cwd: string
  worktreeBranch: string | null
  baselineSha: string
  /** 派单时刻工作区本来就脏的文件;判读时要从改动清单里减掉。 */
  baselineDirty: string[]
  codexBin: string
  marker: string
}

export interface JobState {
  pid: number | null
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  timedOut: boolean
  /** codex exec 事件流里的会话号;老工单或启动失败时为 null。 */
  threadId: string | null
}

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * 新建的 worktree **没有自己的 node_modules**,验收命令(vitest / vue-tsc)会当场 ENOENT
 * —— 表现是"派出去的活每次都判红",极容易误诊成 Codex 干得不对。这里链一份主工位的过去。
 * Windows 用目录联接(junction),POSIX 用符号链接。
 *
 * ⚠ 拆的时候只许拆链接本身(见 unlinkNodeModules):对着 junction 递归删,会把主工位真正的
 * node_modules 一起删光(本机踩过)。
 */
/** 看板仓库的依赖不在根目录:前端那份在 web/node_modules;根目录那份只装派单器自己要的 tsx。两处都链。 */
const NODE_MODULES_DIRS = ['node_modules', 'web/node_modules']

export const linkNodeModules = (worktreePath: string): void => {
  for (const rel of NODE_MODULES_DIRS) {
    const target = join(REPO_ROOT, rel)
    const link = join(worktreePath, rel)
    if (!existsSync(target) || existsSync(link)) continue
    const r = IS_WIN
      ? spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
      : spawnSync('ln', ['-s', target, link], { encoding: 'utf8' })
    if (r.status !== 0) {
      process.stderr.write(
        '[codex-runner] ⚠ ' + rel + ' 没链成,验收命令可能起不来:\n' + (r.stderr || r.stdout || '') + '\n',
      )
    }
  }
}

/** 只摘链接,不碰链接指向的真实目录。 */
export const unlinkNodeModules = (worktreePath: string): void => {
  for (const rel of NODE_MODULES_DIRS) {
    const link = join(worktreePath, rel)
    if (!existsSync(link)) continue
    if (IS_WIN) {
      // rmdir 对 junction 只删链接本身;绝不能用 rm -rf / Remove-Item -Recurse。
      spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8' })
    } else {
      spawnSync('rm', [link], { encoding: 'utf8' })
    }
  }
}

/** --worktree:给这一单开独立工作区 + 独立分支,产出不污染派单方的工位。 */
const ensureWorktree = (slug: string): string => {
  const { path, branch } = worktreeFor(slug)
  if (existsSync(path)) {
    linkNodeModules(path)
    return path
  }
  mkdirSync(join(REPO_ROOT, '.codex', 'worktrees'), { recursive: true })
  const add = spawnSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (add.status !== 0) {
    throw new Error('[codex-runner] 建 worktree 失败:\n' + (add.stderr || add.stdout || ''))
  }
  linkNodeModules(path)
  return path
}

/**
 * 派单:落盘 + 起后台进程,立刻返回。
 * 返回工单目录,调用方拿去 collect。
 */
export const dispatch = (task: CodexTask): { dir: string; pid: number | null; cwd: string } => {
  const paths = jobPaths(task.slug)
  mkdirSync(paths.dir, { recursive: true })
  mkdirSync(paths.acceptanceLogDir, { recursive: true })

  const cwd = task.worktree ? ensureWorktree(task.slug) : (task.cwd ?? REPO_ROOT)
  if (!existsSync(cwd)) throw new Error('[codex-runner] 工作目录不存在:' + cwd)

  const taskJson = JSON.stringify(task, null, 2) + '\n'
  writeFileSync(paths.task, taskJson, 'utf8')

  const prompt = renderPrompt(task)
  writeFileSync(paths.prompt, prompt, 'utf8')

  const schemaPath = join(paths.dir, 'verdict.schema.json')
  writeJson(schemaPath, VERDICT_SCHEMA)

  // 先把事件流文件占出来:监工进程要 ~0.5 秒冷启动才会创建它,而 `dispatch --watch`
  // 是紧接着就去开窗格的 —— 不占位,窗格会被"事件流不存在"的闸挡掉,
  // 表现成"--watch 时灵时不灵"这种最难查的偶发。
  if (!existsSync(paths.execLog)) writeFileSync(paths.execLog, '', 'utf8')

  const codexBin = resolveCodexBin()
  const meta: JobMeta = {
    slug: task.slug,
    taskId: task.taskId,
    taskHash: sha256(taskJson),
    dispatchedAt: new Date().toISOString(),
    cwd,
    worktreeBranch: task.worktree ? worktreeFor(task.slug).branch : null,
    baselineSha: git(['rev-parse', 'HEAD'], cwd).out,
    baselineDirty: dirtyFiles(cwd),
    codexBin,
    marker: completionMarker(task.slug),
  }
  writeJson(paths.meta, meta)

  // 起一个**监工进程**,而不是直接把 codex 甩出去 detach。
  // 为什么多这一层:直接 detach 的话没人接退出码、没人管超时 —— 判决里的 exitCode 永远是
  // null,timedOut 永远是 false,"进程崩了"和"跑完了但没打标记"就分不开了(而这两种情况
  // 该给的结论完全不同:前者要重派,后者要看它到底卡在哪)。监工同步等 codex 收场,
  // 把退出码和超时如实写进 state.json,再自己退出。代价是多一个 tsx 冷启动(~0.5 秒)。
  // 用 node --import tsx 直接拉起,**不要走 npx.cmd**:Node 20 起(CVE-2024-27980 加固)
  // 不带 shell 直接 spawn .cmd 会当场 EINVAL —— 报错长得像"参数写错了",
  // 实际是平台策略,查半天查不到自己头上。
  const supervisor = spawn(
    process.execPath,
    ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts'), '_supervise', task.slug],
    { cwd: REPO_ROOT, detached: true, stdio: 'ignore', windowsHide: true },
  )
  supervisor.unref()

  const state: JobState = {
    pid: supervisor.pid ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    threadId: null,
  }
  writeJson(paths.state, state)

  return { dir: paths.dir, pid: supervisor.pid ?? null, cwd }
}

/**
 * 监工:同步等 codex exec 收场,把退出码/超时如实落进 state.json。
 * 由 dispatch 以后台进程方式拉起,不该被人直接调用。
 */
export const supervise = async (slug: string): Promise<void> => {
  const paths = jobPaths(slug)
  const meta = readJson<JobMeta>(paths.meta)
  const task = readJson<CodexTask>(paths.task)
  if (!meta || !task) throw new Error('[codex-runner] 工单不完整,监工无法接管:' + slug)

  const prompt = readFileSync(paths.prompt, 'utf8')
  const args = [
    'exec',
    '--cd', meta.cwd,
    '--sandbox', task.sandbox,
    '--skip-git-repo-check',
    '--json',
    '--output-schema', join(paths.dir, 'verdict.schema.json'),
    '-o', paths.lastMessage,
    ...(task.model ? ['--model', task.model] : []),
    prompt,
  ]

  // 直接把 stdout/stderr 灌进文件:事件流可能上百兆,走内存缓冲会被 maxBuffer 截断。
  const logFd = openSync(paths.execLog, 'w')
  const child = spawn(meta.codexBin, args, {
    cwd: meta.cwd,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(child.pid as number)
    } catch {
      /* 已经自己退了 */
    }
  }, task.timeoutSec * 1000)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })
  clearTimeout(timer)
  closeSync(logFd)

  const prev = readJson<JobState>(paths.state)
  writeJson(paths.state, {
    pid: prev?.pid ?? null,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode,
    timedOut,
    threadId: extractThreadId(paths.execLog),
  } satisfies JobState)
}

/** 进程还活着吗。信号 0 只探活不真发信号。 */
export const isAlive = (pid: number | null): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 完工标记有没有在事件流里出现过。 */
export const markerPrinted = (execLogPath: string, marker: string): boolean => {
  if (!existsSync(execLogPath)) return false
  return readFileSync(execLogPath, 'utf8').includes(marker)
}

/** 相对派单时刻的净改动(减掉基线本来就脏的文件)。 */
export const changedSince = (cwd: string, baselineDirty: string[]): string[] => {
  const before = new Set(baselineDirty.map((p) => p.replace(/\\/g, '/')))
  return dirtyFiles(cwd)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !before.has(p))
}

/**
 * 派单器自己把验收断言重跑一遍 —— 这是整套桥的立身之本。
 * 人工项不跑,标 manual 交人核。
 */
export const runAcceptance = (task: CodexTask, cwd: string, logDir: string): MachineAcceptance[] =>
  task.acceptance.map((item) => {
    const argv = resolveAcceptanceArgv(item)
    if (!argv) return { id: item.id, required: item.required, ran: false, passed: false, exitCode: null, manual: true }

    const { cmd, args, shell } = acceptanceSpawnOptions(argv)
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
      shell,
    })
    const output = (r.stdout || '') + '\n' + (r.stderr || '')
    writeFileSync(join(logDir, item.id + '.log'), argv.join(' ') + '\n\n' + output, 'utf8')

    // r.status 为 null 代表进程压根没起来或被信号杀掉 —— 那是"没跑",不是"没过"。
    const ran = r.status !== null && !r.error
    return {
      id: item.id,
      required: item.required,
      ran,
      passed: ran && r.status === 0,
      exitCode: r.status,
    }
  })

export const taskFrozen = (taskPath: string, expectedHash: string): boolean =>
  existsSync(taskPath) && sha256(readFileSync(taskPath, 'utf8')) === expectedHash
