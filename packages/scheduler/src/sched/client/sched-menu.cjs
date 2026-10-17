'use strict'

/**
 * HUB0 命令识别(卡 SCHED-HUB0-PROJECT-MENU-0924;设计正本 §5.2 前两道判据)。
 *
 * classifyCommand(项目, argv) 把一条挂号命令与项目菜单比对:
 * - 认出:给出「菜单项 + 受限参数」,再按菜单项属性和 resources.exclusive 判能不能搬;
 * - 认不出:原因码一律 unknown-command(Q1:认不出的留本机跑,不算报错),why 细分是哪一步没过。
 * 受限参数口径照 scripts/bot/cluster-job.ts 的 SHELL_METACHARS 与 TARGET_SEGMENT(仓库内相对路径、禁 `..`、
 * 禁 shell 元字符),差两处:反斜杠先统一成正斜杠再查(Windows 路径分隔符,执行端一律按正斜杠还原);
 * `%` 也算元字符(cmd 的变量展开)。
 * validateMenuArgs 给执行端复核用:工单只带「菜单项 + 受限参数」,执行端按自己那份菜单再校验一遍。
 * 纯函数:只 require 同目录的注册表,不读写共享盘、不起子进程、不接进任何运行路径(接线归 HUB3、HUB5)。
 */

const { normalizeProjectId, getProject } = require('./sched-projects.cjs')

const SHELL_METACHARS = /[&|;`$()<>{}^!"'%\r\n]/
const SAFE_PATH = /^[A-Za-z0-9_./*@-]+$/
const ABSOLUTE = /^([A-Za-z]:|[/\\])/
const SAFE_ARG = /^[A-Za-z0-9_./@=-]+$/
const MAX_WORDS = 64
const MAX_ARG_LENGTH = 200
const WORKERS_FLAG = /^--maxWorkers=\d+$/
const BUILD_MODE = /^[a-z][a-z0-9-]{0,31}$/
const PROTECTED_OUT_DIRS = new Set(['.git', 'node_modules'])
const GRADLE_SWITCHES = new Set(['--no-daemon', '--no-parallel', '--offline', '--stacktrace', '--info', '--console=plain', '--continue'])
const GRADLE_WORKERS = /^--max-workers=[1-9][0-9]?$/
const GRADLE_TASK = /^:?[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/
const GRADLE_PROPERTY = /^-P[A-Za-z0-9_.-]+=(.+)$/
const COMMAND_SUFFIX = /\.(exe|cmd|bat|ps1)$/
const COMMAND_ALIASES = new Map([['python3', 'python'], ['py', 'python']])

/** 仓库内的安全相对路径:非空、不超过 200 字、只含 TARGET_SEGMENT 字符、不以 - 开头、不含 ..、不是绝对路径。 */
function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ARG_LENGTH && SAFE_PATH.test(value)
    && !value.startsWith('-') && !value.includes('..') && !ABSOLUTE.test(value)
}

/** 装依赖这类参数:允许以 - 开头的开关和 `=`,其余同安全相对路径。 */
function isSafeArg(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ARG_LENGTH && SAFE_ARG.test(value)
    && !value.includes('..') && !ABSOLUTE.test(value)
}

function stripDotSlash(word) {
  let text = word
  while (text.startsWith('./')) text = text.slice(2)
  return text
}

/** 命令词去掉 ./、转小写、去掉 .exe/.cmd/.bat/.ps1(不做别名映射)。 */
function baseCommandWord(word) {
  return stripDotSlash(word.replace(/\\/g, '/')).toLowerCase().replace(COMMAND_SUFFIX, '')
}

/** 命令词规范化:再把 python3、py 当作 python。非字符串返回空串。 */
function normalizeCommandWord(word) {
  if (typeof word !== 'string') return ''
  const base = baseCommandWord(word)
  return COMMAND_ALIASES.get(base) ?? base
}

function unknown(project, why, detail) {
  return Object.freeze({ recognized: false, reason: 'unknown-command', why, detail, project })
}

/** 在项目菜单里找最长前缀匹配的写法;words[0] 已规范化,其余逐词字面比。 */
function matchForm(menu, words) {
  let best = null
  for (const menuItem of menu) {
    for (const form of menuItem.forms) {
      if (form.cmd.length > words.length || (best && form.cmd.length <= best.form.cmd.length)) continue
      if (form.cmd.every((word, index) => word === words[index])) best = { menuItem, form }
    }
  }
  return best
}

function dropWorkers(args) {
  const kept = []
  for (let index = 0; index < args.length; index += 1) {
    if (WORKERS_FLAG.test(args[index])) continue
    if (args[index] === '--maxWorkers' && /^\d+$/.test(args[index + 1] ?? '')) { index += 1; continue }
    kept.push(args[index])
  }
  return kept
}

function isSafeOutDir(value) {
  if (!isSafeRelativePath(value) || value.includes('*')) return false
  const first = value.split('/').find((segment) => segment !== '' && segment !== '.')
  return first !== undefined && !PROTECTED_OUT_DIRS.has(first.toLowerCase())
}

function checkToolConfig(tools, args) {
  if (args.length === 0) return null
  if (!tools.includes(args[0])) return `工具只收 ${tools.join('、')},不收 ${args[0]}`
  if (args.length === 1) return null
  const config = args[2]
  if (args.length === 3 && args[1] === '-p' && isSafeRelativePath(config) && !config.includes('*') && config.endsWith('.json')) return null
  return `${args[0]} 只收 --noEmit 和 -p <仓库内 .json 配置>`
}

function checkBuildFlags(args) {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]
    const next = args[index + 1]
    if (word === '--emptyOutDir') continue
    if (word === '--outDir' && isSafeOutDir(next)) { index += 1; continue }
    if (word === '--mode' && typeof next === 'string' && BUILD_MODE.test(next)) { index += 1; continue }
    return `构建参数只收 --emptyOutDir、--outDir <仓库内目录,不能是仓库根、.git、node_modules>、--mode <名字>,不收 ${word}`
  }
  return null
}

function checkGradle(args) {
  for (const word of args) {
    if (GRADLE_SWITCHES.has(word) || GRADLE_WORKERS.test(word)) continue
    const property = GRADLE_PROPERTY.exec(word)
    if (property) {
      if (isSafeRelativePath(property[1])) continue
      return `gradle 属性 ${word} 的值要是仓库内相对路径或简单取值`
    }
    if (word.startsWith('-')) return `gradle 开关 ${word} 不在许可清单里`
    if (!GRADLE_TASK.test(word)) return `${word} 不是 gradle 任务名`
  }
  return null
}

/** 受限参数文法;通过返回 null,不通过返回原因。 */
function checkGrammar(grammar, args) {
  switch (grammar.kind) {
    case 'none':
      return args.length === 0 ? null : `不收参数,多了 ${args.join(' ')}`
    case 'paths': {
      const bad = args.find((word) => !isSafeRelativePath(word))
      return bad === undefined ? null : `${bad} 不是仓库内的安全相对路径`
    }
    case 'choice':
      return args.length === 1 && grammar.values.includes(args[0]) ? null : `只收 ${grammar.values.join('、')} 其中一个`
    case 'tool-config':
      return checkToolConfig(grammar.tools, args)
    case 'build-flags':
      return checkBuildFlags(args)
    case 'gradle':
      return checkGradle(args)
    case 'safe-args': {
      const bad = args.find((word) => !isSafeArg(word))
      return bad === undefined ? null : `${bad} 含不许的字符、是绝对路径或含 ..`
    }
    default:
      return `菜单文法 ${grammar.kind} 不认识`
  }
}

/** 按写法的 tail、alias、require、drop 和写法级文法,从前缀后的参数算出用户给的受限参数;不通过返回 { why }。 */
function restArgs(form, rest) {
  let args = rest
  if (form.tail === 'none' && args.length > 0) return { why: `${form.cmd.join(' ')} 后面不收参数,多了 ${args.join(' ')}` }
  if (form.tail === 'npm' && args.length > 0) {
    if (args[0] !== '--') return { why: `npm 脚本的参数要写在 -- 后面,不收 ${args[0]}` }
    args = args.slice(1)
  }
  if (form.alias) args = args.map((word) => (Object.hasOwn(form.alias, word) ? form.alias[word] : word))
  for (const flag of form.require ?? []) {
    if (!args.includes(flag)) return { why: `${form.cmd.join(' ')} 要带 ${flag}` }
    args = args.filter((word) => word !== flag)
  }
  if (form.drop?.includes('maxWorkers')) args = dropWorkers(args)
  const why = form.args ? checkGrammar(form.args, args) : null
  return why ? { why } : { args }
}

/**
 * 认命令。project 可写别名;argv 是挂号命令行(sched.cjs run 的 `--` 之后,命令词在前);
 * options.exclusive 是票据的 resources.exclusive,非空一律钉挂号机。
 */
function classifyCommand(project, argv, options = {}) {
  const projectId = normalizeProjectId(project)
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_WORDS || argv.some((word) => typeof word !== 'string')) {
    return unknown(projectId.id, 'invalid-argv', `命令行要是 1~${MAX_WORDS} 个字符串`)
  }
  if (!projectId.registered) return unknown(projectId.id, 'project-unregistered', `项目 ${projectId.id || '(空)'} 没在注册表登记,留本机跑`)
  const entry = getProject(projectId.id)
  if (!entry.accepted) return unknown(entry.id, 'project-not-accepted', `项目 ${entry.id} 不接(${entry.note}),留本机跑`)
  const words = argv.map((word) => word.replace(/\\/g, '/'))
  const dirty = words.find((word) => SHELL_METACHARS.test(word))
  if (dirty !== undefined) return unknown(entry.id, 'shell-metachar', `含 shell 元字符:${dirty}`)
  const inner = words.length >= 2 && normalizeCommandWord(words[0]) === 'cmd' && words[1].toLowerCase() === '/c' ? words.slice(2) : words
  if (inner.length === 0) return unknown(entry.id, 'no-match', 'cmd /c 后面没有命令')
  const head = normalizeCommandWord(inner[0])
  let tail = inner.slice(1)
  if (baseCommandWord(inner[0]) === 'py' && tail[0] === '-3') tail = tail.slice(1)
  tail = tail.map(stripDotSlash)
  const match = matchForm(entry.menu, [head, ...tail])
  if (!match) {
    if (/[/:]/.test(head)) return unknown(entry.id, 'command-path', `命令词带路径(${inner[0]}):执行机上的路径不一样,换成菜单里的写法才能搬`)
    const bad = tail.find((word) => ABSOLUTE.test(word) || word.includes('..'))
    if (bad !== undefined) return unknown(entry.id, 'bad-argument', `参数 ${bad} 是绝对路径或含 ..`)
    return unknown(entry.id, 'no-match', `这条命令不在 ${entry.id} 的菜单里,留本机跑;常用的话加进菜单`)
  }
  const { menuItem, form } = match
  const rest = restArgs(form, tail.slice(form.cmd.length - 1))
  if (rest.why) return unknown(entry.id, 'bad-argument', rest.why)
  const args = [...(form.emit ?? []), ...rest.args]
  const why = checkGrammar(menuItem.args, args)
  if (why) return unknown(entry.id, 'bad-argument', `${menuItem.id}:${why}`)
  const exclusive = options?.exclusive
  const exclusiveEmpty = exclusive === undefined || (Array.isArray(exclusive) && exclusive.length === 0)
  const pinReason = menuItem.pinReason ?? (exclusiveEmpty ? null : 'exclusive-resource')
  return Object.freeze({
    recognized: true, project: entry.id, item: menuItem.id, args: Object.freeze(args),
    portable: menuItem.portable && exclusiveEmpty, pinReason, category: menuItem.category, cores: menuItem.cores,
  })
}

function refuse(why, detail) {
  return Object.freeze({ ok: false, why, detail })
}

/** 执行端复核:工单里的「菜单项 + 受限参数」过一遍自己那份菜单。project 可写别名。 */
function validateMenuArgs(project, itemId, args) {
  const entry = getProject(project)
  if (!entry) return refuse('project-unregistered', `项目 ${String(project)} 没在注册表登记`)
  if (!entry.accepted) return refuse('project-not-accepted', `项目 ${entry.id} 不接`)
  const menuItem = entry.menu.find((candidate) => candidate.id === itemId)
  if (!menuItem) return refuse('no-such-item', `${entry.id} 的菜单里没有 ${String(itemId)}`)
  if (!Array.isArray(args) || args.length > MAX_WORDS || args.some((word) => typeof word !== 'string')) {
    return refuse('invalid-args', `受限参数要是至多 ${MAX_WORDS} 个字符串`)
  }
  const dirty = args.find((word) => SHELL_METACHARS.test(word) || word.includes('\\'))
  if (dirty !== undefined) return refuse('shell-metachar', `含 shell 元字符或反斜杠:${dirty}`)
  const why = checkGrammar(menuItem.args, args)
  if (why) return refuse('bad-argument', `${menuItem.id}:${why}`)
  return Object.freeze({ ok: true, project: entry.id, item: menuItem.id, args: Object.freeze([...args]) })
}

module.exports = { SHELL_METACHARS, SAFE_PATH, isSafeRelativePath, normalizeCommandWord, classifyCommand, validateMenuArgs }
