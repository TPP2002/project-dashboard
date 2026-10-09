/**
 * 派单器拉起的每一个 Codex 进程(首轮 exec / 续聊 exec resume)统一带的四对 `-c`
 * 配置覆盖(CODEX-WORKER-DISABLE-DESKTOP-MCP-1009,2026-10-09)。
 *
 * 【为什么关】Codex 桌面版升级(0.162.0-alpha.2)会往 ~/.codex/config.toml 注入两个工具服务与
 * 一个回合结束钩子:顶层 [mcp_servers.node_repl]、unified-computer-use 插件自带的 cua_repl
 * 工具服务,以及顶层 notify = [codex-computer-use.exe, "turn-ended"]。它们运行时都持有
 * cua_node 运行时目录里的文件(node_repl.exe、@oai\sky\...\VCRUNTIME140_1.dll 等),而新版
 * 沙箱在每条命令前做 setup refresh 时新增「运行时读/执行权限校验」,要独占打开同一批文件改
 * 权限 —— 任何进程正在运行/加载其中的文件就报 os error 32「另一个程序正在使用此文件」,
 * 写出 ~/.codex/.sandbox/setup_error.json = helper_unknown_error「setup refresh had errors」,
 * 工人所有命令起不来。工人自己不启动这两个服务、不跑 notify,就没有跟自己沙箱撞车的进程。
 *
 * 【为什么 node_repl 要补一条 command 占位】致命坑(本机 0.162.0-alpha.2 实测):配置里
 * **没有**某个工具服务时,单写 `-c mcp_servers.<名>.enabled=false` 会新建一个只有 enabled
 * 的条目,codex 直接报「failed to load bootstrap configuration / invalid transport」起不来。
 * 所以 enabled=false 之后必须紧跟 `command="disabled-by-codex-dispatch"` 占位:有 node_repl
 * 的机器上它只是把已关掉的服务的启动命令换成占位,没有的机器上它让这条新造的条目有合法传输、
 * 处于关闭状态 —— 实测两种机器都能正常起,mcp list 显示 disabled。两对必须同进同退,不许只留
 * enabled 那条。
 *
 * 【为什么插件键不加引号】`-c plugins.unified-computer-use@openai-bundled.enabled=false` 的
 * 插件键**不加引号**才生效;实测带引号写成 plugins."unified-computer-use@openai-bundled".enabled
 * 不生效,cua_repl 仍会被插件拉起来。插件不存在的机器上这条无害(实测不存在的插件名照常起)。
 *
 * 【为什么绝不能写 mcp_servers.cua_repl】cua_repl 来自插件、不在配置的 mcp_servers 表里;
 * 对它写 enabled=false 正是上面那个「配置里没有该服务」的坑,会让 codex 直接起不来。
 * 关插件那条已经让它从工具清单里消失,不需要也不能再单独覆盖。
 *
 * 【写法】派单器 spawn 不走 shell,argv 元素里的双引号是字符串内容的一部分,原样写进数组;
 * false、[]、带引号字符串都是合法 TOML。
 *
 * 【为什么单放一个极小模块】看板仓的 codex-runner 与 codex-say 本来就互相导入(runner 用
 * say 的 extractThreadId,say 用 runner 的 resolveCodexBin);常量放这个独立小模块,runner/say
 * 两处同引一份,不给既有环再添负担。
 */
export const CODEX_WORKER_CONFIG_OVERRIDES = [
  '-c', 'mcp_servers.node_repl.enabled=false',
  '-c', 'mcp_servers.node_repl.command="disabled-by-codex-dispatch"',
  '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false',
  '-c', 'notify=[]',
] as const

/**
 * 【为什么去掉 WindowsApps(codexWorkerEnv,2026-10-09 下午实测,续聊第 2 轮)】负责人已在
 * 全局 ~/.codex/config.toml 把沙箱档改成不提权([windows] sandbox = "unelevated";等 OpenAI
 * 修好后再改回提权档,卡 CODEX-SANDBOX-REVERT-ELEVATED-1009),不提权沙箱下 setup refresh
 * 不再报 os error 32。但 codex 的默认 shell 会解析到
 * `C:\Users\demo\AppData\Local\Microsoft\WindowsApps\pwsh.exe` —— 用户目录下应用商店版
 * PowerShell 7 的「应用执行别名」;不提权沙箱的受限令牌起不了它,每条命令都报
 * `CreateProcessAsUserW failed: 5 (拒绝访问。)`,工人还是零改动。实测把传给 codex.exe 的
 * PATH 里指向 WindowsApps 的条目去掉后,codex 退回 System32 下系统自带的
 * WindowsPowerShell\v1.0\powershell.exe,`echo sandbox-ok` 退出码 0。
 *
 * 【两条边界】①派单器**不写死** windows.sandbox 档位:沙箱跟全局配置走,将来全局改回提权档
 * 时这里一个字不用动。②去掉 WindowsApps 在提权档下也没有坏处 —— 只是退回系统自带的
 * PowerShell,所以这条过滤不需要跟着沙箱档位开关。
 *
 * 【改法】只动 PATH 这一个键:Windows 上环境变量键名大小写不定(常见 `Path`),不区分大小写
 * 去找、保留原键名,绝不另加第二个 PATH 键;按 `;` 拆开,条目去掉末尾斜杠、统一斜杠方向、
 * 不区分大小写后包含 `\microsoft\windowsapps` 的去掉,其余条目顺序与原文一字不动(空条目也
 * 原样保留,不凭空多出分号)。没有 PATH 键、或非 win32 平台:原样返回;其余变量一个不动。
 * 浅拷贝返回,不改传入对象。
 */
export const codexWorkerEnv = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  if (platform !== 'win32') return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const rawPath = pathKey === undefined ? undefined : env[pathKey]
  if (pathKey === undefined || rawPath === undefined) return env
  const keptEntries = rawPath.split(';').filter((entry) => {
    const normalized = entry.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    return !normalized.includes('\\microsoft\\windowsapps')
  })
  return { ...env, [pathKey]: keptEntries.join(';') }
}
