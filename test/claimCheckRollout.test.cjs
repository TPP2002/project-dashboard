'use strict';
/**
 * claimCheckRollout.test.cjs —— 过渡期安全(HOOK-CLAIM-GATE-MULTI-PROJECT)。
 *
 * 闸门的判定挪进了 CLI 的 claim-check。若 hook 先更新、看板本体还是旧版(没有这个命令),
 * 天真的 `|| exit 1` 会让【所有装了 hook 的仓库】从此一条 commit 都提交不了——
 * 闸门自己跑不起来,不该等价于"你没认领"。本用例把 DASHBOARD_HOME 指向一个"旧版 CLI"
 * (只会退出码 2 的假 index.cjs),验证 commit 仍能过、并且吵出一条警告。
 */
process.env.DASHBOARD_HOME = require('node:fs').realpathSync.native(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'oldcli-')),
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const cmds = require('../cli/commands.cjs');

const FAKE_HOME = process.env.DASHBOARD_HOME;

test('看板 CLI 是旧版(没有 claim-check)时:commit 放行 + stderr 警告,不堵死仓库', () => {
  // 假的"旧版 CLI":任何子命令都按 index.cjs 对未知命令的约定退出码 2
  fs.mkdirSync(path.join(FAKE_HOME, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(FAKE_HOME, 'cli', 'index.cjs'),
    "console.error('未知命令'); process.exit(2);\n");

  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  for (const a of [['init', '-q'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 't'],
    ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  }
  cmds.register({ id: 't', name: 'demo', root: repo, registry: reg });
  hooksInstall({ project: 't', registry: reg });
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feat-rollout'], { stdio: 'ignore' });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
  execFileSync('git', ['-C', repo, 'add', 'a.txt'], { stdio: 'ignore' });
  const out = execFileSync('git', ['-C', repo, 'commit', '-m', 'rollout'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(out !== undefined, 'commit 应当成功(闸门跑不起来 ≠ 你没认领)');

  const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /rollout/);

  // 警告必须真的打出来(否则闸门静默失效,没人会发现)
  const pre = fs.readFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(pre, /看板 claim 闸门已跳过/);
  assert.match(pre, />&2/, '警告走 stderr,不会被 hook 的 >/dev/null 吞掉');

  for (const d of [dir, FAKE_HOME]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 清理失败不判红 */ }
  }
});
