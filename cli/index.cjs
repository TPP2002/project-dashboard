#!/usr/bin/env node
'use strict';
/**
 * index.cjs —— CLI 入口：参数解析 + 惰性命令分发。
 * 用法: node cli/index.cjs <命令> [--project <id>] [参数]
 * 全局 flag: --project <id>（省略则按 cwd 的 git 仓反查，见下）、--author <身份>、--json、--registry <path>（测试用）。
 *
 * 惰性加载：命令 → [模块, 导出名]，dispatch 时才 require。
 * 好处=并行对话各实现各的命令文件、无需改本入口，文件域彻底隔离、零撞车。
 * 未实现的命令文件不存在时，触发该命令才友好报错，不影响其它命令。
 */

/** 解析 argv：位置参数进 _，--key value 进 flags（重复 key 收集成数组，末位 --flag 记 true） */
function parseFlags(argv) {
  const _ = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else {
        if (flags[key] === undefined) flags[key] = next;
        else if (Array.isArray(flags[key])) flags[key].push(next);
        else flags[key] = [flags[key], next];
        i++;
      }
    } else { _.push(a); }
  }
  flags._ = _;
  return flags;
}

// 命令 → [模块相对路径, 导出名]
const REGISTRY = {
  // —— 已实现（core+cli 承重墙）——
  register: ['./commands.cjs', 'register'], add: ['./commands.cjs', 'add'],
  claim: ['./commands.cjs', 'claim'], unclaim: ['./commands.cjs', 'unclaim'],
  progress: ['./commands.cjs', 'progress'],
  pending: ['./commands.cjs', 'pending'], decide: ['./commands.cjs', 'decide'],
  park: ['./commands.cjs', 'park'], unpark: ['./commands.cjs', 'unpark'], block: ['./commands.cjs', 'block'],
  done: ['./commands.cjs', 'done'], cancel: ['./commands.cjs', 'cancel'], reopen: ['./commands.cjs', 'reopen'],
  note: ['./commands.cjs', 'note'],
  edit: ['./commands.cjs', 'edit'], set: ['./commands.cjs', 'set'],
  list: ['./commands.cjs', 'list'], show: ['./commands.cjs', 'show'],
  cost: ['./commands.cjs', 'cost'],
  // protocol 给规矩，brief 给任务书；两者都只读。
  protocol: ['./protocol.cjs', 'protocol'],
  brief: ['./brief.cjs', 'brief'],
  precheck: ['./precheck.cjs', 'precheck'], cleanup: ['./cleanup.cjs', 'cleanup'],
  'docs-audit': ['./docsAudit.cjs', 'docsAudit'],
  'sync-from-git': ['./gitSync.cjs', 'syncFromGit'], doctor: ['./gitSync.cjs', 'doctor'],
  'claim-check': ['./claimCheck.cjs', 'claimCheck'],
  // 发布副本(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT):各仓 hook 只认它;合进主干后跑一次让新代码生效
  release: ['./release.cjs', 'release'],
  'hooks-trunk-guard': ['./hooksInstall.cjs', 'hooksTrunkGuard'],
  'mark-landed': ['./commands.cjs', 'markLanded'],
  'sync-progress': ['./commands.cjs', 'syncProgress'],
  inbox: ['./inboxCmd.cjs', 'inbox'],
  // —— 由并行对话实现（惰性；文件未建时触发会提示"尚未实现"）——
  'hooks-install': ['./hooksInstall.cjs', 'hooksInstall'],
  'hooks-global': ['./hooksInstall.cjs', 'hooksGlobal'],
  import: ['./importCmd.cjs', 'importCmd'],
  backfill: ['./backfill.cjs', 'backfill'],
  'render-index': ['./renderIndex.cjs', 'renderIndex'],
  snapshot: ['./snapshot.cjs', 'snapshot'],
  'archive-activity': ['./archiveActivity.cjs', 'archiveActivity'],
  onboard: ['./onboard.cjs', 'onboard'],
  enroll: ['./enroll.cjs', 'enroll'],
};

/**
 * 不吃 --project 的命令（AUD-CLI-BATCH-AND-AUTOPROJECT ③ 的例外表）。
 * 两类：① 压根没有"当前项目"这个概念的（register 用 --id、enroll 用 --id、release 发的是代码副本、
 * claim-check / hooks-global / hooks-trunk-guard 一次扫全部已注册项目）；
 * ② sync-progress / protocol 自己软探测：前者认不出就跳过，后者用项目占位符，不因共仓歧义报错。
 * 给这些命令做反查纯属白跑一个 git 子进程，而 claim-check 挂在每次 commit 上，那点开销是要还的（审计 A9）。
 */
const NO_AUTO_PROJECT = new Set([
  'register', 'enroll', 'release', 'claim-check', 'hooks-global', 'hooks-trunk-guard', 'sync-progress', 'protocol',
]);

/**
 * --project 可省略：按 cwd 所在的 git 仓反查唯一项目，就地填进 flags（AUD-CLI-BATCH-AND-AUTOPROJECT ③）。
 * 在【入口填一次】而不是让 resolveProject 自己猜的理由见 core/resolveProject.cjs 头注。
 *   · 恰好 1 个 → 填上，下游一律当显式传的用；
 *   · ≥2 个（一个仓同时登记给多个项目）→ 当场停，要人显式写，绝不靠 registry 的插入顺序决胜；
 *   · 0 个 → 不填，让命令自己报"缺 --project"（那句话已经把用法写清楚了）。
 */
function autoFillProject(cmd, flags) {
  if (NO_AUTO_PROJECT.has(cmd)) return;
  if (flags.project !== undefined && flags.project !== true) return;
  const { detectProjectIds } = require('../core/resolveProject.cjs');
  const registryPath = flags.registry && flags.registry !== true
    ? require('node:path').resolve(String(flags.registry)) : undefined;
  const hits = detectProjectIds({ registryPath });
  if (hits.length === 1) { flags.project = hits[0]; return; }
  if (hits.length > 1) {
    console.error(`✖ 省略了 --project，但当前仓库同时登记给 ${hits.length} 个看板项目：${hits.join('、')}\n` +
      '  （板的家 mainRepo 与代码的家 codeRepo 都算命中）机器猜不出这张卡属于哪个，请显式写 --project <id>。');
    process.exit(1);
  }
}

/**
 * 帮助渲染(AUD-CLI-BRIEF-AND-HELP,审计 §4-A1)。惰性 require:不看帮助的调用不该为它付启动成本。
 * @param {string} [cmd] 给了就打单条命令的一屏用法;不给就打全局一览。
 * @returns {boolean} 有没有打出来(命令不存在时 false,交调用方按未知命令处理)
 */
function printHelp(cmd) {
  const help = require('./help.cjs');
  const { displayCliCommand } = require('../core/runtimeRoot.cjs');
  const cli = displayCliCommand();
  if (cmd) {
    const text = help.renderCommandHelp(cmd, { cli });
    if (!text) return false;
    console.log(text);
    return true;
  }
  console.log(help.renderGlobalHelp({ cli, commands: Object.keys(REGISTRY) }));
  return true;
}

/**
 * 写命令的 `--json` 只回变更摘要(AUD-CLI-BRIEF-AND-HELP,审计 §4-A4)。
 * 旧版回吐整个 task 对象——技术说明、全部决策、全部提交号一次全给,几千 token,
 * 而调用方要的只是"成了没、现在什么状态、动了哪些字段"。要整卡去 `show <卡号> --full`。
 * 不带 task 的结果(note / doctor / list …)原样放行,它们各有各的形状。
 */
function slimJson(res) {
  const t = res && res.task;
  if (!t) return res;
  return {
    ok: res.ok !== false,
    id: t.id,
    status: t.status,
    percent: t.percent || 0,
    changed: res.changed || [],
  };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // `help <命令>` / 裸 help / 无参数：全局一览或单条用法。
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = cmd === 'help' ? rest.find((a) => !a.startsWith('-')) : undefined;
    if (target && !printHelp(target)) {
      console.error('未知命令: ' + target + '。可用: ' + Object.keys(REGISTRY).join(' '));
      process.exit(2);
    }
    if (!target) printHelp();
    process.exit(0);
  }
  const entry = REGISTRY[cmd];
  if (!entry) { console.error('未知命令: ' + cmd + '。可用: ' + Object.keys(REGISTRY).join(' ')); process.exit(2); }
  // `<命令> --help`：必须抢在下面的 need() 与建卡机器闸之前，否则 `pending --help` 会被当成
  // "缺参数 --project"、`add --help` 会被 --model 闸拦下 —— AGENTS.md 让施工方走的正是这条路。
  if (rest.includes('--help') || rest.includes('-h')) { printHelp(cmd); process.exit(0); }

  let fn;
  try { fn = require(entry[0])[entry[1]]; }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') { console.error(`✖ 命令 ${cmd} 尚未实现（缺 ${entry[0]}）`); process.exit(3); }
    throw e;
  }
  if (typeof fn !== 'function') { console.error(`✖ 命令 ${cmd} 尚未实现（${entry[0]} 未导出 ${entry[1]}）`); process.exit(3); }

  const flags = parseFlags(rest);
  autoFillProject(cmd, flags);
  // 批量建卡(add --json-file / --json)的档位与人话标题闸是【逐项】判的(见 commands.addBatch),
  // 这里放行,否则整批必被这两道单卡闸拦死——它们查的是命令行 flag,批量清单里根本没有。
  const batchAdd = cmd === 'add' && require('./commands.cjs').isBatchAdd(flags);
  // ADD-MODEL-GATE(0901 负责人拍板):命令行建卡必须标建议档位——纪律靠自觉必失守,机器闸兜底。
  // 只拦 CLI 入口;内部编程调用 cmds.add(importCmd 历史导入/docsAudit 自动巡检卡/测试)不经此处。
  if (cmd === 'add' && !batchAdd && (flags.model === undefined || flags.model === true || String(flags.model).trim() === '')) {
    console.error('✖ 建卡必须带 --model <建议档位>(0901 拍板,机器闸)。按模型路由表(skill §12.2)照抄一个:\n' +
      '  机械执行/清单/一行修 → --model "sonnet·低"\n' +
      '  照单施工/接线/修复   → --model "opus·中"\n' +
      '  设计/评审/校准/疑难  → --model "fable·高"\n' +
      '  负责人亲办不开对话   → --model "负责人本人办"\n' +
      '  (编排型可组合,如 "fable·高编排+opus施工";≤40 字符)');
    process.exit(1);
  }
  // ADD-PLAINTITLE-GATE(CLI-ADD-NO-PLAINTITLE-FILESCOPE):建卡三件套(skill §11.9)要求
  // plainTitle(负责人看的人话标题)与 title(模型看的技术说明)都要给——纪律靠自觉必失守,
  // --model 闸已证明有效,同样机器闸兜底。只拦 CLI 入口,内部编程调用不经此处。
  if (cmd === 'add' && !batchAdd && (flags['plain-title'] === undefined || flags['plain-title'] === true || String(flags['plain-title']).trim() === '')) {
    console.error('✖ 建卡必须带 --plain-title <人话标题>(skill §11.9 建卡三件套,机器闸兜底)。\n' +
      '  --title 是给模型看的技术详细说明(照旧不变),--plain-title 是另加给负责人看的一句人话\n' +
      '  (20~35 字,禁文件名/路径/函数名/类名/命令/英文缩写/内部编号)。例:\n' +
      '  add T1 --model "sonnet·低" --title "统一 roundToTick 的实现" \\\n' +
      '         --plain-title "价格计算的四舍五入有五套规则并存,可能算出对不上的数字"\n' +
      '  （顺手可加 --scope "<glob>"（可重复）登记这张卡大概会改哪些文件，不必等 claim 才补）');
    process.exit(1);
  }
  try {
    const res = fn(flags) || { ok: true };
    if (res.silent) return;
    if (flags.json) console.log(JSON.stringify(slimJson(res)));
    else if (res.text) console.log(res.text);
    else console.log(`✔ ${cmd}` + (res.task ? ` ${res.task.id} → ${res.task.status}` : ''));
  } catch (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  }
}

// 直接跑才分发；被 require 时只导出注册表（test/cliHelp.test.cjs 拿它逐条比对帮助覆盖率）。
if (require.main === module) main();

module.exports = { REGISTRY, parseFlags };
