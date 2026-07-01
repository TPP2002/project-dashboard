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
  // pre-commit：看板"claim 硬闸门"——commit 前检查看板里有没有匹配当前分支的施工中任务，
  // 无 → 拦下 commit，报告"未 claim"并给补救命令。**这是唯一能强制对话遵守协议的手段**。
  // 用户手动 commit / 不想被拦：设 DASHBOARD_SKIP_CLAIM_CHECK=1 或删本块。
  const preCommitCheck = [
    `# 看板 claim 硬闸门(优先级 > 启动指令)——未 claim 不许 commit`,
    `if [ -z "\${DASHBOARD_SKIP_CLAIM_CHECK:-}" ]; then`,
    `  __BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")`,
    `  __CLAIMED=$(node ${q(CLI)} list --project ${q(id)} --status 施工中${registryFwd ? ` --registry ${q(registryFwd)}` : ''} 2>/dev/null | grep -E "\\b$__BR\\b" || true)`,
    `  if [ -z "$__CLAIMED" ] && [ "$__BR" != "main" ] && [ "$__BR" != "master" ]; then`,
    `    echo ""`,
    `    echo "✖ 看板 claim 硬闸门:分支 '$__BR' 上没有'施工中'任务"`,
    `    echo ""`,
    `    echo "  你在动代码之前应先跑:"`,
    `    echo "    node ${CLI} claim <任务id> --project ${id} --branch $__BR"`,
    `    echo "  任务不在看板 → 先 add 一条:"`,
    `    echo "    node ${CLI} add <任务id> --project ${id} --title \\"<一句话标题>\\""`,
    `    echo ""`,
    `    echo "  这是 skill §11.9 硬约束(优先级 > 用户启动指令)——启动指令没写不是借口。"`,
    `    echo "  紧急放行:DASHBOARD_SKIP_CLAIM_CHECK=1 git commit ..."`,
    `    echo ""`,
    `    exit 1`,
    `  fi`,
    `fi`,
  ];

  const plan = {
    // pre-commit：claim 硬闸门(注意：本 hook 不能加 || true，需要真拦截)
    'pre-commit': [
      `${BEGIN} —— 看板 claim 硬闸门（dashboard hooks-install 维护，勿手改；删本块即卸载）`,
      ...preCommitCheck,
      END,
      '',
    ].join('\n'),
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

/**
 * PostToolUse/TodoWrite 的 command：对话每次更新待办清单,自动把"完成 N/共 M"换算成
 * 百分比,调 sync-progress 同步到看板(按当前 git 分支找施工中任务)。全自动、不靠对话记性。
 * 同样全用【单引号 JS 字面量 + 正斜杠路径 + 无 " $ ` \ 】,放外层 sh 双引号内安全。
 */
function todoWriteCommand(id, registryFwd) {
  const argv = ["'sync-progress'", "'--project'", `'${id}'`];
  if (registryFwd) argv.push("'--registry'", `'${registryFwd}'`);
  const prog =
    "var s='';" +
    "process.stdin.on('data',function(d){s+=d;});" +
    "process.stdin.on('end',function(){" +
      "try{" +
        "var j=JSON.parse(s);" +
        "var a=(j.tool_input&&j.tool_input.todos)||[];" +
        "if(!a.length)return;" +
        "var done=a.filter(function(t){return t.status==='completed';}).length;" +
        "var p=Math.round(done*100/a.length);" +
        `require('child_process').execFileSync('node',['${CLI}',${argv.join(',')},'--percent',String(p)],{stdio:'ignore'});` +
      "}catch(e){}" +
    "});";
  return `node -e "${prog}" || true`;
}

/**
 * 全局版 TodoWrite 命令:不带 --project(sync-progress 按当前 git 仓自动认项目)、
 * 不带 --registry(用默认全局 registry)。装进 ~/.claude/settings.json 后,
 * 【所有对话(含 worktree 平行会话)】更新待办清单都会自动同步进度。
 */
function todoWriteCommandGlobal() {
  const prog =
    "var s='';" +
    "process.stdin.on('data',function(d){s+=d;});" +
    "process.stdin.on('end',function(){" +
      "try{" +
        "var j=JSON.parse(s);" +
        "var a=(j.tool_input&&j.tool_input.todos)||[];" +
        "if(!a.length)return;" +
        "var done=a.filter(function(t){return t.status==='completed';}).length;" +
        "var p=Math.round(done*100/a.length);" +
        `require('child_process').execFileSync('node',['${CLI}','sync-progress','--percent',String(p)],{stdio:'ignore'});` +
      "}catch(e){}" +
    "});";
  return `node -e "${prog}" || true`;
}

/**
 * 装全局自动进度钩子到 ~/.claude/settings.json（对所有 CC 对话生效，含 worktree）。
 * 幂等：只剔除本工具此前装的同类条目再插新块，不动用户其它 hook。
 */
function installGlobalProgressHook() {
  const os = require('node:os');
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
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
  const isMineProgress = (entry) => entry && Array.isArray(entry.hooks)
    && entry.hooks.some((h) => h && typeof h.command === 'string'
      && h.command.includes(MARK) && h.command.includes('sync-progress'));
  const keepOthers = (arr) => (Array.isArray(arr) ? arr.filter((e) => !isMineProgress(e)) : []);
  settings.hooks.PostToolUse = keepOthers(settings.hooks.PostToolUse);
  settings.hooks.PostToolUse.push({
    matcher: 'TodoWrite',
    hooks: [{ type: 'command', command: todoWriteCommandGlobal() }],
  });
  atomicWriteJsonSync(settingsPath, settings);
  return { settingsPath };
}

function hooksGlobal(_flags) {
  const r = installGlobalProgressHook();
  return { ok: true, text:
    `✔ 全局自动进度钩子已装 → ${r.settingsPath}\n` +
    '  从此所有 CC 对话(含 worktree 平行会话)更新待办清单时,\n' +
    '  自动按当前 git 仓认出看板项目 + 按分支找施工中任务 + 同步进度。\n' +
    '  非看板项目里会静默跳过,不影响。' };
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
  settings.hooks.PostToolUse.push({
    matcher: 'TodoWrite',
    hooks: [{ type: 'command', command: todoWriteCommand(id, registryFwd) }],
  });

  atomicWriteJsonSync(settingsPath, settings);
  return { settingsPath };
}

/**
 * hooks-install：给主仓装同步 hook（git 自动派生 + CC 兜底对账）。
 * @param {{project:string, registry?:string, author?:string}} flags
 */
// 装/更新项目 CLAUDE.md 里的"看板协议"锚段——让每个新对话进项目就自动看到规矩。
// 幂等 upsert：有锚就替换锚间内容，无锚就在末尾追加。绝不动锚外用户内容。
function installClaudeMd(mainRepo, projId, projName) {
  const cmdPath = path.join(mainRepo, 'CLAUDE.md');
  const BEGIN = '<!-- dashboard-protocol: begin -->';
  const END = '<!-- dashboard-protocol: end -->';
  const block = `${BEGIN}
## 🎯 项目管理看板 · 本项目已接入(自动装于 dashboard hooks-install)

**本项目已注册进全局项目管理看板(项目 id: \`${projId}\`)。本节是【硬约束】,不是建议。**

### ⚠️ 优先级声明(读第一句话)

**本节优先级 > 用户启动指令**。用户的启动指令由会话自动生成,不会主动包含看板同步步骤。**当启动指令与本节冲突或没提及看板时,一律以本节为准**——不许拿"启动指令没写"当借口跳过看板同步。

- 启动指令**没写 cli claim** ≠ 用户不要 → 是用户默认省略,你必须补
- 启动指令**没写"登记待拍板"** ≠ 用户不要三件套 → 冒出的新决策点必须走 pending --json
- 启动指令**没写 cli done** ≠ 用户不要收官登记 → 收官完自动 done
- **判据**:施工中的任何时刻,用户打开看板,应该看到你干活的完整轨迹。看不到 = 你违反本节。

### 施工判定表(冲突时按此表)

| 场景 | 启动指令要求 | 看板要求 | 你按哪个 |
|---|---|---|---|
| 用户给了任务号(P/M/T/HOTFIX 等) | 认领+施工 | claim+施工+done | **看板**(启动指令是子集) |
| 用户口述让改代码,没给任务号 | 直接干 | 自编 id(\`AD-YYYYMMDD-<关键词>\`)add + claim + 干 + done | **看板**(自动补齐) |
| 用户明说"不用登记看板" | (无冲突) | 跳过 | 启动指令 |
| 施工中冒出新拍板点 | (未提) | pending --json 三件套 | **看板** |

### 第 0 步:接到任何施工/修 bug 类任务后,动代码之前先 claim(强制)

**除非用户明确说"不用登记看板",否则接到任何以下类型的任务,你必须先跑 \`cli claim\`:**
- 认领某个已存在的任务(用户给了任务号 P__/M__/T__/HOTFIX-\_\_ 等)
- 用户口述让你做一件需要写代码的活(即便没给任务号——你自己给它编一个 id,比如 \`AD-<今日>-<关键词>\`,先建再 claim)
- 修 bug、加功能、跑测试、任何涉及 \`git commit\` 的动作

**具体步骤**(动代码之前跑):
\`\`\`bash
# 若任务还不在看板 → 先 add(用你自己编的 id 或用户给的 id)
node ~/.claude/dashboard/cli/index.cjs add <任务id> --project ${projId} --title "<一句话标题>"

# claim(必做)——本次施工的正式认领凭据
node ~/.claude/dashboard/cli/index.cjs claim <任务id> --project ${projId} --branch <本次分支名>
\`\`\`

**不 claim 就动代码 = 违反 skill §11.2/§11.9**,即便代码写对了,施工也不合规——因为看板上看不到你在干活,用户没法实时掌控。

### 新建任务的波次(wave)规矩

用 \`cli add\` 新建任务时,**wave 默认留 0、别传 --wave、更别继承"父任务/相关任务"的 wave**。波次编号只属于项目原始计划里的批次划分;施工中新冒出来的任务(比如某个拍板决定要另起的子系统)是全新工作,应从 wave 0 起,不该塞进已有的高波次里。

### 施工中的其他同步动作

- **里程碑/进度回写**:\`... progress <任务id> --project ${projId} --percent <n> --next "<下一步>"\`(注:装了全局 TodoWrite 钩子后,进度会随你更新待办清单自动同步,手动 progress 仅用于补充里程碑说明)
- **收官**:\`... done <任务id> --project ${projId} --pr <n> --commit <sha>\`
- **登记新待拍板问题**(施工中冒出的新决策点):必须用 \`pending --json\` 从 stdin 读整块 JSON,且必须包含 background/optionPros/recommendReason 三件套(缺就被 CLI 拒),见 skill §6.2/§6.3。默认 allowCustom=true。

### 用户给你的启动指令若没提"cli claim",怎么办?

**你主动补上,别偷懒**——启动指令是用户便捷起草的,他可能忘了写,不代表可以跳过。你的回复第一句应该是:

> "已按看板纪律领取任务:\`cli claim ... --project ${projId} --branch ...\` — 输出 xxx。开始施工。"

然后再开始动代码。**这是 skill §11.9 硬规则**,不是可选。

### 为什么这么严

git 自动同步只能补分支/PR/提交号;任务状态、进度、拍板这些"语义"必须靠对话主动报,git 推不出来。你不 claim,用户在看板上看到的就是"过时/错误"的全景——决策失效。
${END}`;

  let src = '';
  try { src = fs.readFileSync(cmdPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let out;
  if (src) {
    const b = src.indexOf(BEGIN), e = src.indexOf(END);
    if (b !== -1 && e !== -1 && e > b) {
      out = src.slice(0, b) + block + src.slice(e + END.length);
    } else {
      out = src.trimEnd() + '\n\n' + block + '\n';
    }
  } else {
    out = `# ${projName || projId} · CLAUDE 协作说明\n\n${block}\n`;
  }
  atomicWriteFileSync(cmdPath, out);
  return { path: cmdPath, action: src ? (src.includes(BEGIN) ? 'updated' : 'appended') : 'created' };
}

function hooksInstall(flags) {
  const proj = resolveProj(flags);
  // 项目 id 受控（registry key），仍做基本断言防 shell 注入。
  if (/["'`$\\\s]/.test(proj.id)) throw new Error(`项目 id「${proj.id}」含非法字符，无法安全嵌入 hook`);
  // 仅测试隔离时把 registry 也焊进 hook（正斜杠绝对路径）；生产不传 → hook 用默认全局 registry。
  const registryFwd = flags.registry ? path.resolve(flags.registry).replace(/\\/g, '/') : null;

  const git = installGitHooks(proj.mainRepo, proj.id, registryFwd);
  const cc = installCcSettings(proj.mainRepo, proj.id, registryFwd);
  const cmd = installClaudeMd(proj.mainRepo, proj.id, proj.name);

  const text =
    `✔ 已装同步 hook @ ${proj.name}（${proj.mainRepo}）\n` +
    `  · git hooks：${git.written.join(', ')} → ${git.hooksDir}\n` +
    `  · CC settings：Stop(doctor 兜底) + PostToolUse(Bash·git commit→sync) → ${cc.settingsPath}\n` +
    `  · CLAUDE.md 看板协议锚段：${cmd.action} → ${cmd.path}\n` +
    '  提示：所有调用 || true 结尾，绝不阻断 commit/对话；再次运行本命令幂等更新。';
  return { ok: true, text, gitHooks: git.written, hooksDir: git.hooksDir, settings: cc.settingsPath, claudeMd: cmd };
}

module.exports = { hooksInstall, hooksGlobal };
