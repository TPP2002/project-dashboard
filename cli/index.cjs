#!/usr/bin/env node
'use strict';
/**
 * index.cjs —— CLI 入口：参数解析 + 惰性命令分发。
 * 用法: node cli/index.cjs <命令> --project <id> [参数]
 * 全局 flag: --project <id>（写命令必填）、--author <身份>、--json、--registry <path>（测试用）。
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
  claim: ['./commands.cjs', 'claim'], progress: ['./commands.cjs', 'progress'],
  pending: ['./commands.cjs', 'pending'], decide: ['./commands.cjs', 'decide'],
  park: ['./commands.cjs', 'park'], block: ['./commands.cjs', 'block'],
  done: ['./commands.cjs', 'done'], note: ['./commands.cjs', 'note'],
  set: ['./commands.cjs', 'set'], list: ['./commands.cjs', 'list'], show: ['./commands.cjs', 'show'],
  cost: ['./commands.cjs', 'cost'],
  precheck: ['./precheck.cjs', 'precheck'], cleanup: ['./cleanup.cjs', 'cleanup'],
  'docs-audit': ['./docsAudit.cjs', 'docsAudit'],
  'sync-from-git': ['./gitSync.cjs', 'syncFromGit'], doctor: ['./gitSync.cjs', 'doctor'],
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
  onboard: ['./onboard.cjs', 'onboard'],
  enroll: ['./enroll.cjs', 'enroll'],
};

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('用法: cli <命令> --project <id> [参数]\n命令: ' + Object.keys(REGISTRY).join(' '));
    process.exit(0);
  }
  const entry = REGISTRY[cmd];
  if (!entry) { console.error('未知命令: ' + cmd + '。可用: ' + Object.keys(REGISTRY).join(' ')); process.exit(2); }

  let fn;
  try { fn = require(entry[0])[entry[1]]; }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') { console.error(`✖ 命令 ${cmd} 尚未实现（缺 ${entry[0]}）`); process.exit(3); }
    throw e;
  }
  if (typeof fn !== 'function') { console.error(`✖ 命令 ${cmd} 尚未实现（${entry[0]} 未导出 ${entry[1]}）`); process.exit(3); }

  const flags = parseFlags(rest);
  // ADD-MODEL-GATE(0901 负责人拍板):命令行建卡必须标建议档位——纪律靠自觉必失守,机器闸兜底。
  // 只拦 CLI 入口;内部编程调用 cmds.add(importCmd 历史导入/docsAudit 自动巡检卡/测试)不经此处。
  if (cmd === 'add' && (flags.model === undefined || flags.model === true || String(flags.model).trim() === '')) {
    console.error('✖ 建卡必须带 --model <建议档位>(0901 拍板,机器闸)。按模型路由表(skill §12.2)照抄一个:\n' +
      '  机械执行/清单/一行修 → --model "sonnet·低"\n' +
      '  照单施工/接线/修复   → --model "opus·中"\n' +
      '  设计/评审/校准/疑难  → --model "fable·高"\n' +
      '  负责人亲办不开对话   → --model "负责人本人办"\n' +
      '  (编排型可组合,如 "fable·高编排+opus施工";≤40 字符)');
    process.exit(1);
  }
  try {
    const res = fn(flags) || { ok: true };
    if (flags.json) console.log(JSON.stringify(res));
    else if (res.text) console.log(res.text);
    else console.log(`✔ ${cmd}` + (res.task ? ` ${res.task.id} → ${res.task.status}` : ''));
  } catch (e) {
    console.error('✖ ' + e.message);
    process.exit(1);
  }
}

main();
