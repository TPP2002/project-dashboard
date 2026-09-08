#!/usr/bin/env node
'use strict';
/**
 * 用法：在项目仓根目录跑 node scripts/hook-timing.cjs [--project timing]。
 * --project 只给临时项目命名并显式传给计时命令；省略时测自动识别。本脚本不进发布副本。
 * 对真实项目只读：自建临时 git 仓、registry 和一张施工中卡，四条命令一律显式
 * 传临时 --registry，并在临时仓的当前分支上运行。正常结束、异常与中断均清理临时目录。
 * 每条命令独立启动 node 5 次，取含进程启动的墙钟耗时中位数（毫秒）。
 * sync-progress 每次测量前在计时区外将临时卡进度归零，五次均测实际写入路径。
 * 测量环境是临时板、卡少、数字偏乐观；不能代替真实大板的耗时，也没有发布副本探测成本。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { execFileSync, spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const { parseFlags } = require('../cli/index.cjs');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.cjs');
const RUNS = 5;

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log('用法：node scripts/hook-timing.cjs [--project timing]（只使用临时看板）');
    return;
  }
  if (flags._.length || Object.keys(flags).some((key) => !['_', 'project'].includes(key))) {
    throw new Error('只支持 --project <临时项目名> 和 --help');
  }
  const project = flags.project === undefined ? 'timing' : flags.project;
  if (typeof project !== 'string' || !/^[A-Za-z0-9_-]+$/.test(project)) {
    throw new Error('--project 必须是由字母、数字、下划线或连字符组成的临时项目名');
  }

  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'hook-timing-'));
  const repo = path.join(dir, 'repo');
  const registry = path.join(dir, 'registry.json');
  const P = { project, registry };
  const overrides = {
    DASHBOARD_HOOK_CLI_ROOT: ROOT,
    DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'),
    DASHBOARD_RELEASE_HOME: path.join(dir, 'release'),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const cleanup = () => {
    // 只删除本次 mkdtemp 创建的直接子目录，不接受外部传来的删除目标。
    if (path.dirname(dir) !== tempRoot || !path.basename(dir).startsWith('hook-timing-')) {
      throw new Error('临时目录越界，拒绝清理');
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  const interrupt = () => process.exit(130);
  const terminate = () => process.exit(143);
  process.once('exit', cleanup);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    Object.assign(process.env, overrides);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig') };
    // 从 git hook 内误启动时也不能让继承的仓库定位覆盖临时 cwd。
    for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
    const git = (args) => execFileSync('git', ['-C', repo, ...args], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
    }).trim();
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'hook-timing', '--template=']);
    git(['config', 'user.email', 'hook-timing@example.invalid']);
    git(['config', 'user.name', 'hook-timing']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['-c', 'core.hooksPath=' + path.join(dir, 'no-hooks'), 'commit', '--allow-empty', '-q', '-m', 'init']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const { board } = cmds.register({ id: project, name: '临时计时板', root: repo, registry });
    cmds.add({ ...P, _: ['TIMING-1'], title: '临时钩子耗时测量' });
    cmds.claim({ ...P, _: ['TIMING-1'], branch });
    hooksInstall(P);

    const commands = [
      ['claim-check'],
      ['sync-progress', '--percent', '50'],
      ['doctor', '--quick', '--quiet'],
      ['doctor', '--quiet'],
    ];
    const projectArgs = flags.project === undefined ? [] : ['--project', project];
    const rows = [];
    for (const args of commands) {
      const samples = [];
      for (let i = 0; i < RUNS; i++) {
        if (args[0] === 'sync-progress') cmds.progress({ ...P, _: ['TIMING-1'], percent: 0 });
        const start = performance.now();
        const result = spawnSync(process.execPath, [CLI, ...args, '--registry', registry, ...projectArgs], {
          cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
        });
        const elapsed = performance.now() - start;
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(`${args.join(' ')} 退出 ${result.status}：${result.stderr || result.stdout}`);
        }
        if (args[0] === 'sync-progress' && JSON.parse(fs.readFileSync(board, 'utf8')).tasks[0].percent !== 50) {
          throw new Error('临时卡进度未写到 50%，本次同步耗时不可用');
        }
        samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      rows.push({ 命令: args.join(' '), 次数: RUNS, '中位数(ms)': samples[Math.floor(RUNS / 2)].toFixed(1) });
    }
    console.log('测量环境是临时板、卡少、数字偏乐观');
    console.table(rows);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    cleanup();
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
