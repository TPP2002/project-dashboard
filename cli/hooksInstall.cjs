'use strict';
/**
 * hooksInstall.cjs —— 装"同步三重保险"里的【git hook 自动派生】+【CC 兜底对账】两环（治本 R2）。
 *
 * 为什么存在：board 同步不能押"对话记得调 CLI"。本命令给主仓装两类 hook，
 * 让 commit / 对话结束时自动把 git 事实反推进 board，人不在场也不漂：
 *   1) <mainRepo>/.git/hooks/post-commit  —— commit 后自动 sync-from-git + render-index
 *      <mainRepo>/.git/hooks/post-merge   —— 分支并入后自动 sync-from-git
 *   2) <mainRepo>/.claude/settings.json   —— CC 的 Stop(每次对话结束跑 doctor 兜底对账)
 *      + PostToolUse/Bash(检测到 git commit 就 sync-from-git)
 *
 * 三条铁律（方案第七节 · 失败隔离）：
 *   · 一切 hook 调用【|| true 结尾】——看板挂了绝不阻断开发者 commit / 对话。
 *   · 【不覆盖用户已有内容】——git hook 无锚则追加、有锚则只换锚块；settings.json 只并入 hooks 键。
 *   · 写 settings.json 走 core/atomicWrite（禁裸 writeFileSync）。
 *
 * 幂等：重复运行只更新自己那一块（git hook 靠 #dashboard-hook 锚、settings 靠 CLI 路径特征识别）。
 *
 * 实测结论（本机 Windows + Git 2.47 + Node 24）：git 用自带 sh 跑 hook，
 * `node "C:/正斜杠/绝对/index.cjs"` 可被原生 node 正确解析——故 hook 里嵌【解析后的正斜杠绝对路径】，
 * 比依赖 `~` 展开 + MSYS 路径翻译更稳。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH, DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

// 全局 CLI 入口绝对路径 → 正斜杠（shell 里免被反斜杠转义 / MSYS 误翻译；原生 node 认正斜杠）。
const CLI = path.join(DASHBOARD_HOME, 'cli', 'index.cjs').replace(/\\/g, '/');
// settings.json 幂等识别用：凡 command 含此特征串的条目，就是"本工具此前装的"，重装时先剔后加。
const MARK = 'dashboard/cli/index.cjs';

// git hook 锚：注释行（# 开头即 shell 注释），begin/end 夹一块可幂等替换的区间。
const BEGIN = '#dashboard-hook:begin';
const END = '#dashboard-hook:end';
// 非全局：正常只有一块，只替换第一处即可（避免多块被替成 N 个相同块）。
const BLOCK_RE = /#dashboard-hook:begin[\s\S]*?#dashboard-hook:end[^\n]*\n?/;

function resolveProj(flags) {
  return resolveProject(flags.project, {
    registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH,
  });
}

/** shell 双引号包裹一个"我们自己生成、受控无引号"的原子串（项目 id / 正斜杠路径）。 */
function q(s) { return '"' + String(s) + '"'; }

/**
 * 拼一条 hook 调用行：`node "<CLI>" <sub> --project "<id>" [--registry "<reg>"] [tail] || true`
 * @param {string} sub 子命令（sync-from-git / render-index / doctor）
 * @param {string} id 项目 id
 * @param {string|null} registryFwd 正斜杠 registry 绝对路径（仅测试隔离时传；生产走默认全局 registry）
 * @param {string} [tail] 额外尾参（如 --quiet）
 */
function cliLine(sub, id, registryFwd, tail) {
  let line = `node ${q(CLI)} ${sub} --project ${q(id)}`;
  if (registryFwd) line += ` --registry ${q(registryFwd)}`;
  if (tail) line += ` ${tail}`;
  return line + ' || true';
}

/** 用 begin/end 锚包出一块 hook 片段（末尾留一个空行，保证块后有换行）。 */
function buildBlock(lines) {
  return [
    `${BEGIN} —— 看板自动同步（dashboard hooks-install 维护，勿手改；删本块即卸载）`,
    ...lines,
    END,
    '',
  ].join('\n');
}

/**
 * upsert hook 文件内容（不覆盖用户原内容）：
 *   · 空/不存在 → 带 #!/bin/sh 新建；
 *   · 已含锚   → 只替换锚块（幂等，顺带刷新路径/id）；
 *   · 有内容无锚 → 末尾追加锚块（保留用户原脚本，不加第二个 shebang）。
 */
function upsertHookContent(existing, block) {
  if (!existing || existing.trim() === '') return '#!/bin/sh\n' + block;
  if (BLOCK_RE.test(existing)) return existing.replace(BLOCK_RE, block);
  const sep = existing.endsWith('\n') ? '' : '\n';
  return existing + sep + '\n' + block;
}

/**
 * 定位主仓 hooks 目录：主仓 .git 恒为目录 → <.git>/hooks；
 * 若 .git 是文件（worktree/子模块重定向，防御）→ 解析 gitdir 后取其 hooks。
 */
function resolveHooksDir(mainRepo) {
  const gitPath = path.join(mainRepo, '.git');
  let st;
  try { st = fs.statSync(gitPath); }
  catch { throw new Error(`${mainRepo} 不是 git 仓库（无 .git），请先在主仓 git init`); }
  if (st.isDirectory()) return path.join(gitPath, 'hooks');
  const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
  if (!m) throw new Error(`${gitPath} 不是有效的 .git 指针文件`);
  const raw = m[1].trim();
  const gitDir = path.isAbsolute(raw) ? raw : path.resolve(mainRepo, raw);
  return path.join(gitDir, 'hooks');
}

/** 写/追加 git hooks（post-commit / post-merge），带锚幂等、chmod 0755。 */
function installGitHooks(mainRepo, id, registryFwd) {
  const hooksDir = resolveHooksDir(mainRepo);
  fs.mkdirSync(hooksDir, { recursive: true });
  const plan = {
    // commit 后：先从 git 反推 board，再刷 INDEX 状态段。两行各自 || true，互不牵连。
    'post-commit': buildBlock([
      cliLine('sync-from-git', id, registryFwd),
      cliLine('render-index', id, registryFwd),
    ]),
    // 分支并入后：反推 board（合并带来的 commit / status:merged 等）。
    'post-merge': buildBlock([
      cliLine('sync-from-git', id, registryFwd),
    ]),
  };
  const written = [];
  for (const [name, block] of Object.entries(plan)) {
    const p = path.join(hooksDir, name);
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    atomicWriteFileSync(p, upsertHookContent(existing, block), { fsyncData: false });
    try { fs.chmodSync(p, 0o755); } catch { /* Windows 无 x 位，无害 */ }
    written.push(name);
  }
  return { hooksDir, written };
}

/**
 * PostToolUse/Bash 的 command：读 CC 从 stdin 传入的事件 JSON，仅当 Bash 命令含 "git commit"
 * 时才跑 sync-from-git（matcher 只能匹配工具名、匹配不到命令内容，故条件放命令里）。
 * 刻意全用【单引号 JS 字面量 + 正斜杠路径 + indexOf 非正则】——整段 prog 内无 " $ ` \ ，
 * 放进外层 sh 双引号里安全（>, &&, ;, () 在双引号内均为普通字符）。
 */
function postToolUseCommand(id, registryFwd) {
  const argv = ["'sync-from-git'", "'--project'", `'${id}'`];
  if (registryFwd) argv.push("'--registry'", `'${registryFwd}'`);
  const call = `require('child_process').execFileSync('node',['${CLI}',${argv.join(',')}],{stdio:'ignore'});`;
  const prog =
    "var s='';" +
    "process.stdin.on('data',function(d){s+=d;});" +
    "process.stdin.on('end',function(){" +
      "try{" +
        "var j=JSON.parse(s);" +
        "var c=(j.tool_input&&j.tool_input.command)||'';" +
        "if(c.indexOf('git commit')>=0){" + call + "}" +
      "}catch(e){}" +
    "});";
  return `node -e "${prog}" || true`;
}

/** 读-合并-写 <mainRepo>/.claude/settings.json：并入 Stop + PostToolUse hook，不覆盖既有键。 */
function installCcSettings(mainRepo, id, registryFwd) {
  const settingsPath = path.join(mainRepo, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8').trim();
    if (raw) {
      try { settings = JSON.parse(raw); }
      catch (e) { throw new Error(`${settingsPath} 不是合法 JSON，拒绝覆盖（请先修复/备份后重试）：${e.message}`); }
    }
  }
  settings.hooks = settings.hooks || {};

  // 幂等 + 不动用户手写条目：只剔除"本工具此前装的"（其某个 command 含 CLI 路径特征），再插新块。
  const isMine = (entry) => entry && Array.isArray(entry.hooks)
    && entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(MARK));
  const keepOthers = (arr) => (Array.isArray(arr) ? arr.filter((e) => !isMine(e)) : []);

  settings.hooks.Stop = keepOthers(settings.hooks.Stop);
  settings.hooks.Stop.push({
    hooks: [{ type: 'command', command: cliLine('doctor', id, registryFwd, '--quiet') }],
  });

  settings.hooks.PostToolUse = keepOthers(settings.hooks.PostToolUse);
  settings.hooks.PostToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: postToolUseCommand(id, registryFwd) }],
  });

  atomicWriteJsonSync(settingsPath, settings);
  return { settingsPath };
}

/**
 * hooks-install：给主仓装同步 hook（git 自动派生 + CC 兜底对账）。
 * @param {{project:string, registry?:string, author?:string}} flags
 */
function hooksInstall(flags) {
  const proj = resolveProj(flags);
  // 项目 id 受控（registry key），仍做基本断言防 shell 注入。
  if (/["'`$\\\s]/.test(proj.id)) throw new Error(`项目 id「${proj.id}」含非法字符，无法安全嵌入 hook`);
  // 仅测试隔离时把 registry 也焊进 hook（正斜杠绝对路径）；生产不传 → hook 用默认全局 registry。
  const registryFwd = flags.registry ? path.resolve(flags.registry).replace(/\\/g, '/') : null;

  const git = installGitHooks(proj.mainRepo, proj.id, registryFwd);
  const cc = installCcSettings(proj.mainRepo, proj.id, registryFwd);

  const text =
    `✔ 已装同步 hook @ ${proj.name}（${proj.mainRepo}）\n` +
    `  · git hooks：${git.written.join(', ')} → ${git.hooksDir}\n` +
    `  · CC settings：Stop(doctor 兜底) + PostToolUse(Bash·git commit→sync) → ${cc.settingsPath}\n` +
    '  提示：所有调用 || true 结尾，绝不阻断 commit/对话；再次运行本命令幂等更新。';
  return { ok: true, text, gitHooks: git.written, hooksDir: git.hooksDir, settings: cc.settingsPath };
}

module.exports = { hooksInstall };
