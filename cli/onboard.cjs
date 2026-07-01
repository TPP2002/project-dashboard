'use strict';
/**
 * onboard.cjs —— 一键接入/回填：import（骨架）→ backfill --patch（语义补丁）→ sync-from-git（补 git 字段）。
 * 收尾时一条命令把项目回填好。首次接入用；重复跑会以 import 重建骨架（慎用于已人工补过语义的 board）。
 * 用法：onboard --project <id> [--from <INDEX.md>] [--patch <json>] [--no-git]
 */
const { importCmd } = require('./importCmd.cjs');
const { backfill } = require('./backfill.cjs');
const { syncFromGit } = require('./gitSync.cjs');

function onboard(flags) {
  const steps = [];
  // 1) import 骨架（非 dry-run 落盘）
  const imp = importCmd({ ...flags, 'dry-run': false });
  steps.push(`import：${imp.count} 个任务骨架`);
  // 2) backfill 语义补丁（可选）
  if (flags.patch) {
    const bf = backfill({ ...flags });
    steps.push('backfill：' + String(bf.text || '').split('\n')[0].replace(/^✔\s*/, ''));
  }
  // 3) sync-from-git 补 git 字段（可选跳过）
  if (!flags['no-git']) {
    try { const s = syncFromGit({ ...flags }); steps.push(`sync-from-git：${s.changed} 任务补 git 字段（扫 ${s.scanned} 提交）`); }
    catch (e) { steps.push('sync-from-git 跳过：' + e.message); }
  }
  return { ok: true, text: '✔ onboard 完成：\n  ' + steps.join('\n  ') + '\n（语义字段 decisions/bot/tests/禁区 仍需 backfill/set 逐个补）' };
}

module.exports = { onboard };
