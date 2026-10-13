'use strict';
/**
 * launcher.cjs —— 双平台启动器编排（DASH-LAUNCHER-NO-SCHED-HOLD-1012 阶段 2）。
 *
 * 启动看板.bat / dashboard.sh 只做 Node 检查后调用本文件；本文件按顺序做六件事：
 *   ⓪ 严格模式第一闸：任何安装、现场构建、起服务【之前】先验证调度客户端可用、派单员心跳没超龄；
 *      不可用就明确拒绝新启动 —— 不 npm、不裸跑、不动已在跑的服务（负责人拍板 d1：默认强制登记，故障拒新启动）。
 *   ⓪′ 启动互斥：数据域内同一时刻只许一个启动器【编排】；第二个双击得到明确的"正在启动"结果，
 *      不写登记、不挂第二张长期单 —— 防的是"两个启动器同时探到 none → 各挂一张 hold"。
 *      锁只盖住"探活→安装→发布→（退旧）→起服务"这一段：本次服务【起稳】（看护把 serverPid
 *      补进登记）就放锁 —— 绝不让锁盖住常驻寿命，否则在跑期间的所有双击都会被锁挡在发布检查
 *      之外，"双击换新版"就又绕不进来了；起稳之后的每次双击都重新走完 ①~⑤ 全流程。
 *   ① 归属【预检】：未知归属/跨模式/开发实例在这里就明确拒接 —— 不安装、不构建、不碰别人的服务；
 *      但【复用/换新】绝不在这里决定（那必须等这次发布之后按新印章判，否则双击永远复用旧版）。
 *   ② 首次依赖安装：严格模式走正式调度 exec（Windows 上 cmd /c npm），独立模式本地直跑（同一命令形态）。
 *   ③ 发布构建：默认语义与旧启动器逐字一致（发布副本自己的 CLI 优先 → 排队构建 → 同源 → 失败回落旧副本）；
 *      只有【显式 --standalone】才把 --standalone 传进发布命令，允许它直连本次 SHA 导出树的 vite。
 *   ④ 复用/换新判定：基于【这次发布之后】的印章重探重判 —— 主干更新了就退旧起新，没更新才复用
 *      （与旧启动器"每次先 release 再按版本换新"的语义一致）；退旧必须确认旧树真的退了才起新单。
 *   ⑤ 起常驻服务：严格模式只申请 1 核、走真实 hold（先授予才拉起服务，看护进程负责账/进程一致）；
 *      独立模式直起，看护进程只看包装进程死活。
 *
 * 【不做什么】不改共享盘客户端与调度策略；不把配置缺省/调度失败自动降级成独立模式；
 * 不接管或杀别人的服务；不修改 dev 入口、托盘、安装包。生命周期细节在 core/launcherRuntime.cjs。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { CODE_ROOT, isGitCheckout, releaseHome, readStamp } = require('../core/runtimeRoot.cjs');
const { resolveSchedShare } = require('../core/settings.cjs');
const { DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const lr = require('../core/launcherRuntime.cjs');
const { serviceStatus } = require('./release.cjs');

/** 看护进程文件（core/launcherRuntime.cjs）自身；hold/启动器都以绝对路径 argv 拉起它。 */
const WATCH_RUNTIME = path.resolve(__dirname, '..', 'core', 'launcherRuntime.cjs');

/** 派单员心跳时效门槛（负责人指定 120 秒）：超龄 = 调度台实质失效，拒绝新启动、不碰旧实例。 */
const HEARTBEAT_MAX_AGE_MS = 120000;

/**
 * 启动锁的"起稳确认"上限：从挂上 hold 起等归属登记里出现 serverPid（看护 spawn 出服务后补记）
 * 这么久，等到就放启动锁。要盖住正常的排队时长（锁在排队期间必须挡住第二个启动器），
 * 但绝不能长到把锁盖在常驻寿命上。超时也放锁（宁可回到"每次双击重新判"的语义，也不锁死编排）。
 */
const START_CONFIRM_MS = 600000;

/** 可取消的有界轮询：等到真值/超时返回；stop() 清掉定时器，不留挂着的事件把进程吊住。 */
function pollUntil(fn, ms, intervalMs = 200) {
  let stopped = false;
  let timer = null;
  const deadline = Date.now() + ms;
  const promise = new Promise((resolve) => {
    const tick = () => {
      if (stopped) return;
      let ok = false;
      try { ok = !!fn(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
  });
  return { promise, stop() { stopped = true; clearTimeout(timer); } };
}

const USAGE = [
  '用法: node cli/launcher.cjs [--standalone]',
  '  默认严格模式：整条启动链（首次依赖安装、现场发布构建、常驻服务）一律经调度台登记；',
  '    调度客户端不可用、共享盘不可读或派单员心跳超龄时明确拒绝新启动：不安装、不构建、不起服务、不动已在跑的实例。',
  '  --standalone 显式独立模式：整条链路不经调度台（供无调度台的用户显式选择，不做任何自动降级）。',
  '  启动看板.bat / dashboard.sh 是薄入口：只检查 Node 后调用本文件。',
  '  背景与实据见 docs/launcher-hold-1014.md。',
].join('\n');

/** 只认 --standalone；别的参数一律报错（零决策：不悄悄转发、不悄悄忽略）。 */
function parseLauncherArgs(argv = []) {
  let standalone = false;
  for (const a of argv) {
    if (a === '--standalone') standalone = true;
    else throw new Error(`不认识的参数：${a}\n${USAGE}`);
  }
  return { standalone };
}

/** 加载真实共享盘客户端；失败=拒绝启动（与 cli/scheduledWork.cjs「排队客户端不可用，重活未启动」同口径）。 */
function loadSchedClient(share) {
  const file = path.join(share, 'sched', 'bin', 'sched.cjs');
  let client;
  try { client = require(file); }
  catch (e) { throw new Error(`排队客户端不可用，启动已拒绝（严格模式不降级、不裸跑）：${file}；${e.message}`); }
  const need = ['status', 'hold', 'exec', 'cancel', 'deriveTicketId', 'validatePermit'];
  const missing = need.filter((k) => typeof client[k] !== 'function');
  if (missing.length) throw new Error(`排队客户端缺少真实 API（${missing.join('/')}），启动已拒绝：${file}`);
  return client;
}

/**
 * 调度台可用性核验：客户端能加载之外，共享盘读得动、派单员心跳也没超龄，才算 ready。
 * 心跳超龄（> HEARTBEAT_MAX_AGE_MS，负责人指定 120 秒）＝ 派单员实质失效 —— 这时新挂的
 * 长期单没人续账、装依赖/构建作业可能挂死：明确拒绝新启动，且不碰已在跑的实例。
 */
function verifySchedulingReady(client, share) {
  let overview = null;
  try { overview = client.status(undefined, { share }); }
  catch (e) {
    return { ok: false, reason: `调度台不可读（${e.message}）。严格模式拒绝新启动：不安装、不构建、不起服务，` +
      '也不动已在跑的实例；修好共享盘后重试，或显式加 --standalone 走独立模式。' };
  }
  const age = overview && Number.isFinite(overview.heartbeatAgeMs) ? overview.heartbeatAgeMs : null;
  if (age === null) {
    return { ok: false, reason: '调度台总览报不出派单员心跳时效（heartbeatAgeMs），无从确认调度台活着。' +
      '严格模式拒绝新启动：不安装、不构建、不起服务，也不动已在跑的实例。' };
  }
  if (age > HEARTBEAT_MAX_AGE_MS) {
    return { ok: false, reason: `派单员心跳已停约 ${Math.round(age / 1000)} 秒（超过 ${HEARTBEAT_MAX_AGE_MS / 1000} 秒门槛）——调度台实质失效。` +
      '严格模式拒绝新启动：不安装、不构建、不起服务，也不动已在跑的实例；修好调度台后重试，或显式加 --standalone 走独立模式。' };
  }
  return { ok: true };
}

/** 探活端口选项遵循既有语义：DASHBOARD_PORT=<起始端口>（server 同款，扫 base~base+8）；0=隔离自检不扫描。 */
function probeOptsFromEnv(env = process.env) {
  if (env.DASHBOARD_PORT !== undefined && env.DASHBOARD_PORT !== '') {
    const base = Number(env.DASHBOARD_PORT);
    if (!(Number.isInteger(base) && base > 0)) return null;
    return { portBase: base, portRange: 8 };
  }
  return { portBase: 6060, portRange: 8 };
}

/** 数据域归属（与 server 的 sameDataScope 同口径）：registry/dataRoot 都对得上才算同域；老版本实例只在无显式覆盖时同域。 */
function sameDataScope(h, env = process.env, { platform = process.platform } = {}) {
  if (!h || !h.registryPath || !h.dataRoot) {
    return !env.DASHBOARD_REGISTRY && !env.DASHBOARD_HOME && !env.DASHBOARD_PORT;
  }
  const home = env.DASHBOARD_HOME ? path.resolve(env.DASHBOARD_HOME) : DASHBOARD_HOME;
  const registry = env.DASHBOARD_REGISTRY ? path.resolve(env.DASHBOARD_REGISTRY) : path.join(home, 'registry.json');
  const identity = (v) => { const r = path.resolve(v); return platform === 'win32' ? r.toLowerCase() : r; };
  return identity(h.registryPath) === identity(registry) && identity(h.dataRoot) === identity(home);
}

/**
 * 启动器的探活：serviceStatus 的原始扫描 + 数据域过滤 —— 不同数据域的看板【不是】本启动器的
 * 旧版候选：不当自有实例复用/换新，也不触碰。DASHBOARD_PORT=0（隔离自检）压根不扫描。
 */
function probeOwnScope(env = process.env, deps = {}) {
  const scan = deps.scan || serviceStatus;
  const opts = probeOptsFromEnv(env);
  if (!opts) return { running: false, health: null, text: 'ℹ DASHBOARD_PORT=0（隔离自检）：启动器不扫描、不接管在跑实例。' };
  const probed = scan(opts);
  if (probed && probed.running && !sameDataScope(probed.health, env, { platform: deps.platform ?? process.platform })) {
    return { running: false, health: null,
      text: `⚠ 端口 ${probed.health.port} 上在跑的看板属于别的数据域（pid ${probed.health.pid}）——本启动器不把它当自己的旧实例，不接管、不触碰。` };
  }
  return probed;
}

/** 复用实例时替它打开浏览器（server 的 openBrowser 不导出，这里做同一件小事，含同一个豁免口）。 */
function openBrowser(url, { platform = process.platform, env = process.env, spawn = cp.spawn.bind(cp) } = {}) {
  if (env.DASHBOARD_NO_OPEN === '1') return;   // 与 server 同款：隔离/脚本场景不弹浏览器
  try {
    if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 开不了就算了，地址已打印 */ }
}

/**
 * 启动编排主流程。deps 全部可注入（单测钉行为用）；生产一个不传，走真实实现。
 * @returns {Promise<number>} 进程退出码（server/hold 退出码透传）
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const d = {
    platform: process.platform,
    hostname: os.hostname(),
    env: process.env,
    codeRoot: CODE_ROOT,
    home: DASHBOARD_HOME,
    relHome: releaseHome(),
    now: () => new Date(),
    random: Math.random,
    readStamp,
    loadClient: loadSchedClient,
    verifyReady: verifySchedulingReady,
    probeHealth: () => probeOwnScope(d.env),
    installCommand: lr.npmInstallCommand,
    runInstallDirect: (cmd) => {
      const r = cp.spawnSync(cmd.command, cmd.args, { cwd: cmd.cwd, stdio: 'inherit', windowsHide: true });
      return r.status === null ? 1 : r.status;
    },
    runInstallExec: async (client, opts) => client.exec(opts),
    runRelease: (cmd) => {
      const r = cp.spawnSync(cmd.command, cmd.args, { stdio: 'inherit', windowsHide: true });
      return r.status === null ? 1 : r.status;
    },
    openBrowser,
    startUnderHold: (client, opts) => client.hold(opts),
    spawnWatcher: (cmd) => cp.spawn(cmd.command, cmd.args, cmd.opts),
    stopTree: lr.stopTree,
    retireOwn: lr.retireOwnInstance,
    startConfirmMs: START_CONFIRM_MS,
    readRecord: lr.readRecord,
    writeRecord: lr.writeRecord,
    kill: (pid, signal) => process.kill(pid, signal),
    acquireMutex: (file) => lr.acquireLaunchMutex(file, { kill: d.kill }),
    log: console.log,
    err: console.error,
    ...deps,
  };
  const { log, err } = d;

  if (argv.includes('--help') || argv.includes('-h')) { log(USAGE); return 0; }
  const { standalone } = parseLauncherArgs(argv);
  const launcherMode = standalone ? 'standalone' : 'strict';

  // 落脚点纪律的前提：启动器站在代码检出里跑（bat/sh 已 cd 到自己所在目录）。
  if (!isGitCheckout(d.codeRoot)) {
    err(`✖ 启动器必须站在看板代码检出里运行（${d.codeRoot} 不是 git 检出）。`);
    return 1;
  }

  // —— 严格模式第一闸：先验证调度客户端可用，再做任何别的动作。 ——
  let client = null;
  let share = null;
  if (!standalone) {
    share = resolveSchedShare();
    try { client = d.loadClient(share); }
    catch (e) { err('✖ ' + e.message); return 1; }
    const ready = d.verifyReady(client, share);
    if (!ready.ok) { err('✖ ' + ready.reason); return 1; }
    log(`调度客户端可用：${share}`);
  } else {
    log('显式独立模式（--standalone）：整条启动链不经调度台。');
  }

  // —— 启动互斥（数据域内同一时刻只许一个启动器【编排】；服务起稳即放锁，不盖常驻寿命）——
  const recordFile = lr.recordPath(d.home);
  const mutex = d.acquireMutex(recordFile + '.lock');
  if (!mutex) {
    // 已有启动器正在编排（装依赖/发布/挂号起服务，尚未起稳）：给明确结果，不重复挂号、不写登记。
    // 服务起稳后锁就放行了 —— 在跑期间的后续双击【不会】走到这里，会照常走完整流程检查并发布最新版。
    const probed = d.probeHealth();
    if (probed && probed.text) log(probed.text);
    log('已有另一个启动器正在编排（安装/发布/挂号起服务中）：本次不起第二单；等它起稳后再双击，就会照常检查并发布最新版本。');
    return 0;
  }
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; mutex.release(); } };
  try {
    // —— ① 归属【预检】：未知/异域/跨模式/开发实例在这里就明确拒接 —— 不安装、不构建、不碰别人的服务。
    //     复用/换新【绝不】在这里决定：那要等这次发布之后按新印章判（否则双击永远复用旧版、合了不生效）。
    const record = d.readRecord(recordFile);
    const pre = d.probeHealth();
    const preRoute = lr.classifyInstance({
      health: pre && pre.running ? pre.health : null, record, launcherMode, client, share,
      hostname: d.hostname, stamp: d.readStamp(d.relHome), releaseRoot: d.relHome,
      noRestart: d.env.DASHBOARD_NO_RESTART === '1',
    });
    if (preRoute.kind === 'refuse') { err('✖ ' + preRoute.reason); return 1; }

    // —— ② 首次依赖安装 ——
    const webRoot = path.join(d.codeRoot, 'web');
    if (!fs.existsSync(path.join(webRoot, 'node_modules'))) {
      log('[1/3] 首次使用：安装界面依赖（只装一次，可能要一两分钟）……');
      const cmd = d.installCommand(d.platform, webRoot);
      let code;
      if (standalone) {
        code = d.runInstallDirect(cmd);
      } else {
        // 正式 exec 挂号执行（Windows 包 cmd /c npm）；指纹只收 package.json，node_modules 不进内容指纹。
        const key = lr.newLifecycleKey('webinstall', { hostname: d.hostname, now: d.now(), random: d.random });
        const r = await d.runInstallExec(client, {
          share, root: webRoot, project: 'dashboard', key,
          category: 'other', workType: 'install', cores: 1, title: '看板界面依赖安装',
          targets: ['package.json'], engine: 'codex',
          command: cmd.command, args: cmd.args,
        });
        code = (r && r.exitCode) ?? 1;
        if (code === 2) err('依赖安装挂号被拒：' + ((r && r.reason) || ''));
      }
      if (code !== 0) {
        err(`✖ 依赖安装失败（退出码 ${code}），上面有原因。原因排除后重试` +
          (standalone ? '。' : '；确有显式独立运行的需要，可加 --standalone（默认不降级）。'));
        return code || 1;
      }
    } else {
      log('[1/3] 界面依赖已就绪。');
    }

    // —— ③ 发布（旧副本回落语义与旧启动器逐字一致；绝不先停旧服务再安装/构建） ——
    log('[2/3] 正在检查并发布最新版本（主干没更新一两秒就过；有更新要现场构建界面）……');
    const relCli = path.join(d.relHome, 'cli', 'index.cjs');
    const releaseArgs = [fs.existsSync(relCli) ? relCli : path.join(d.codeRoot, 'cli', 'index.cjs'),
      'release', '--source', d.codeRoot];
    if (standalone) {
      // 只有【明确的独立选择】才把 --standalone 传进发布命令：release 会因此直连本次 SHA 导出树的 vite。
      // 旧副本的发布工具若不认识这个旗标会退回排队构建 —— 没有调度台就会如实失败，绝不悄悄伪造许可。
      releaseArgs.push('--standalone');
    }
    const relCode = d.runRelease({ command: process.execPath, args: releaseArgs });
    if (relCode !== 0) {
      if (fs.existsSync(path.join(d.relHome, 'server', 'server.cjs'))) {
        log('⚠ 这次发布没成功（上面有原因）。先用上一次发布好的那份启动 —— 它可能不是最新的。');
      } else {
        err(`✖ 发布失败，而且这台机器上还没有可用的发布副本，起不了服务（退出码 ${relCode}）。`);
        return relCode || 1;
      }
    }

    // —— ④ 复用/换新判定：必须基于【这次发布之后】的印章 —— 主干更新了就退旧起新，没更新才复用。 ——
    const stampNow = d.readStamp(d.relHome);
    const probed = d.probeHealth();
    if (probed && probed.text) log(probed.text);
    const health = probed && probed.running ? probed.health : null;
    const route = lr.classifyInstance({
      health, record, launcherMode, client, share,
      hostname: d.hostname, stamp: stampNow, releaseRoot: d.relHome,
      noRestart: d.env.DASHBOARD_NO_RESTART === '1',
    });

    if (route.kind === 'refuse') { err('✖ ' + route.reason); return 1; }
    if (route.kind === 'reuse' || route.kind === 'reuse-old') {
      if (route.kind === 'reuse-old') log('⚠ DASHBOARD_NO_RESTART=1 → 不动在跑的旧版本实例，复用它。注意：你看到的仍是旧版本。');
      log(`复用本启动器登记且归属/票据验证通过的实例（端口 ${route.health.port}，pid ${route.health.pid}），不重复挂号、不重复长期占核。`);
      log(`看板地址：http://127.0.0.1:${route.health.port}/`);
      d.openBrowser(`http://127.0.0.1:${route.health.port}/`, { platform: d.platform, env: d.env });
      return 0;
    }
    if (route.kind === 'restart-own-old') {
      log(`检测到本启动器登记的旧版本实例（pid ${route.record.serverPid}），按既有换新语义退旧单、停旧进程，再起新单。`);
      const retired = await d.retireOwn({ record: route.record, client, share, stopTree: d.stopTree, log, platform: d.platform });
      if (!retired || retired.ok !== true) {
        err(`✖ 旧实例没有退干净（${(retired && retired.reason) || '未知原因'}），本次不另起新单 —— 宁可不起，也不双跑。`);
        return 1;
      }
    }

    // —— ⑤ 起常驻服务 ——
    const serverPath = path.join(d.relHome, 'server', 'server.cjs');
    if (!fs.existsSync(serverPath)) {
      err(`✖ 发布副本里没有 server（${serverPath}），起不了服务。`);
      return 1;
    }
    log(`[3/3] 正在启动看板服务（代码来自：${d.relHome}）。关掉看板：在本窗口按 Ctrl+C，或直接关掉窗口。`);
    // 归属登记先落盘：探活/复用/换新全靠它；看护进程凭 --key 补记 watcherPid/serverPid，登记换主绝不拼改。
    const lifecycle = {
      schema: lr.RECORD_SCHEMA,
      hostname: d.hostname,
      mode: launcherMode,
      key: lr.newLifecycleKey('serve', { hostname: d.hostname, now: d.now(), random: d.random }),
      ticketId: null,
      title: null,
      wrapperPid: process.pid,
      watcherPid: null,
      serverPid: null,
      serverCodeRoot: d.relHome,
      releaseCommit: stampNow ? stampNow.commit : null,
      startedAt: d.now().toISOString(),
    };

    // 起服务的共同收尾：等服务【起稳】（看护把 serverPid 补进登记）就放启动锁 —— 锁只护编排、
    // 不盖常驻寿命；起稳后的双击能重新拿锁、重新发布、重新判复用/换新。没等到起稳就退
    // （挂号被拒/许可不过等）也立刻放锁，退出码照常透传。
    const runAndRelease = async (runPromise) => {
      const waiter = pollUntil(() => {
        const r = d.readRecord(recordFile);
        return !!(r && Number.isInteger(r.serverPid) && r.serverPid > 0);
      }, d.startConfirmMs);
      const outcome = await Promise.race([
        waiter.promise.then((up) => (up ? 'started' : 'timeout')),
        runPromise.then(() => 'exited'),
      ]);
      waiter.stop();
      if (outcome === 'started') log('看板服务已起稳：本次启动编排完成，放行后续双击（它们会重新检查并发布最新版本）。');
      else if (outcome === 'timeout') log('⚠ 迟迟未见服务起稳的登记（可能在排队）：先放行启动锁，不锁死编排；本窗口继续等待。');
      releaseOnce();
      return await runPromise;
    };

    if (standalone) {
      d.writeRecord(recordFile, lifecycle);
      const args = lr.watcherArgv({ runtimePath: WATCH_RUNTIME, wrapperPid: process.pid, recordFile, serverPath, key: lifecycle.key });
      const child = d.spawnWatcher({
        command: process.execPath, args,
        opts: { cwd: d.codeRoot, stdio: 'inherit', windowsHide: true },
      });
      const childPromise = new Promise((res) => {
        child.once('exit', (c, s) => res(c ?? (s ? 130 : 1)));
        child.once('error', () => res(1));
      });
      return await runAndRelease(childPromise);
    }

    // 严格模式：只申请 1 核（实据见 docs/launcher-hold-1014.md），用真实 hold；
    // hold 先挂号→当拍授予→才由它拉起看护进程；看护进程验过真实授予才 spawn server 并负责账/进程一致。
    lifecycle.ticketId = client.deriveTicketId('dashboard', lifecycle.key);
    lifecycle.title = lr.residentTitle(d.hostname);
    d.writeRecord(recordFile, lifecycle);
    const holdArgs = lr.watcherArgv({
      runtimePath: WATCH_RUNTIME, ticketId: lifecycle.ticketId, share,
      wrapperPid: process.pid, recordFile, serverPath, key: lifecycle.key,
    });
    const holdPromise = (async () => {
      let result;
      try {
        result = await d.startUnderHold(client, {
          share, project: 'dashboard', cores: lr.RESIDENT_CORES,
          title: lifecycle.title, key: lifecycle.key,
          category: 'other', workType: 'other',
          // 内容指纹只收运行期代码目录，不做全仓扫描；root=检出（稳定 cwd 纪律，绝不进发布副本）。
          targets: ['core', 'cli', 'server', 'package.json'],
          root: d.codeRoot, command: process.execPath, args: holdArgs,
          engine: 'codex',
        });
      } catch (e) {
        err(`✖ 常驻服务没能登记启动：${e && e.message}`);
        return 1;
      }
      const code = (result && result.exitCode) ?? 1;
      if (code === 2) err('✖ 常驻服务挂号被拒：' + ((result && result.reason) || ''));
      else if (code === 3) err('✖ 共享盘故障：' + ((result && result.reason) || ''));
      return code;
    })();
    return await runAndRelease(holdPromise);
  } finally {
    releaseOnce();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code ?? 0; })
    .catch((e) => { console.error('✖ ' + (e && e.message)); process.exitCode = 1; });
}

module.exports = {
  main, parseLauncherArgs, loadSchedClient, verifySchedulingReady, openBrowser,
  probeOptsFromEnv, sameDataScope, probeOwnScope, HEARTBEAT_MAX_AGE_MS, USAGE, WATCH_RUNTIME,
};
