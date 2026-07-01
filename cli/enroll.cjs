'use strict';
/**
 * enroll.cjs —— 全新项目一键接入看板：register + hooks-install（+可选自动 import）。
 * 让"接入新项目"从两步降到一步；hooks-install 同步会给项目 CLAUDE.md 追加协议锚段，
 * 让本项目的所有未来 AI 对话一进项目就看到看板同步纪律。
 *
 * 用法：
 *   cli enroll --id <id> --name <名字> --root <项目路径> [--no-hooks] [--from <INDEX/BOARD.md>]
 * 例：
 *   cli enroll --id foo --name Foo --root F:/projects/foo
 *   cli enroll --id foo --name Foo --root F:/projects/foo --from F:/projects/foo/TASKS.md
 */
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('./commands.cjs');
const { hooksInstall } = require('./hooksInstall.cjs');
const { importCmd } = require('./importCmd.cjs');

function need(v, msg) { if (v === undefined || v === true || v === '') throw new Error(msg); return v; }

function enroll(flags) {
  const id = need(flags.id, '--id <项目 id>（短 slug，如 foo）');
  const name = need(flags.name, '--name <展示名>');
  const root = need(flags.root, '--root <项目根路径>');
  const steps = [];

  // ① 注册
  register({ id, name, root, registry: flags.registry });
  steps.push(`register: 已注册 ${id} → ${root}`);

  // ② 装 hook（默认装；--no-hooks 可跳过）
  if (!flags['no-hooks']) {
    // 装 hook 需要项目是 git 仓库；若不是，跳过并提示
    const gitDir = path.join(root, '.git');
    if (fs.existsSync(gitDir)) {
      const h = hooksInstall({ project: id, registry: flags.registry });
      steps.push('hooks-install: 已装 git + CC hook + CLAUDE.md 协议锚');
      steps.push(`  · git hooks: ${h.gitHooks.join(', ')}`);
      steps.push(`  · CC settings: ${h.settings}`);
      steps.push(`  · CLAUDE.md 协议锚: ${h.claudeMd.action} → ${h.claudeMd.path}`);
    } else {
      steps.push('hooks-install: 跳过（项目不是 git 仓库）—— 装了 git 后手动跑 `cli hooks-install --project ' + id + '`');
    }
  } else {
    steps.push('hooks-install: 跳过（--no-hooks）');
  }

  // ③ 可选自动 import 任务台账
  if (flags.from || autoDetectTaskFile(root)) {
    try {
      const imp = importCmd({ project: id, from: flags.from, registry: flags.registry, 'dry-run': false });
      steps.push(`import: ${imp.count} 个任务骨架 已抽入 board`);
    } catch (e) {
      steps.push(`import: 跳过（${e.message.split('\n')[0]}）`);
    }
  }

  return { ok: true, text: '✔ enroll 完成：\n  ' + steps.join('\n  ') + '\n\n以后本项目的 AI 对话:\n  · 看到 CLAUDE.md 里的看板协议\n  · 调 cli pending 时 background/optionPros/recommendReason 缺一个就被拒\n  · 每次 git commit 自动同步 commit/PR/分支到看板\n  · 每次对话结束跑 doctor 兜底对账' };
}

function autoDetectTaskFile(root) {
  for (const cand of ['INDEX.md', 'BOARD.md', 'TASKS.md']) {
    if (fs.existsSync(path.join(root, cand))) return path.join(root, cand);
  }
  return null;
}

module.exports = { enroll };
