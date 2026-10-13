'use strict';
/**
 * builderCallers.test.cjs —— 施工方式新接口两处明确未占用旧调用的回归门禁(DASH-CLAIM-BUILDER-GATE-1010)。
 *
 * 治的病:claim 的 --builder 变成必填机器闸后,两个仍在生成/发起 claim 的旧调用点要是漏带
 * --builder,会被新闸当场拒收、正常入口卡死:
 *   · cli/dispatchPrompt.cjs —— 派单任务书生成的 claim 模板(派出的活由收单员施工 → 派单器);
 *   · scripts/hook-timing.cjs —— 计时脚本自建临时卡的认领(脚本辅助 → 自干:例外③)。
 * 两处都按【真实消费者】验:生成文本替换占位后真执行、脚本整体真跑,
 * 不拿"源码里包含某参数"的字符串检查替代;注册表、数据根、git 配置全在临时目录,
 * 不碰生产卡与全局配置。旧代码(两处调用点未补 --builder)上这两条必须红在【行为】上
 * ——命令被新闸拒收——而不是红在模块加载失败(要 require 的模块/要跑的文件旧代码都有)。
 * 派单那条的参数字样验证放在真执行之后:旧码第一条必须红在"生成的命令缺必填 --builder、
 * 被真实 CLI 拒收"上,不许在字符串断言提前结束。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { buildTaskDispatchPrompt } = require('../cli/dispatchPrompt.cjs');

const CODE_ROOT = path.resolve(__dirname, '..');

/** 临时目录(已 realpath):注册表、数据根、git 配置全圈在里面,测完清理。 */
function tempDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } });
  return dir;
}

test('派单任务书生成的 claim 命令带 --builder 派单器:替换占位后真执行能合法落卡', (t) => {
  const dir = tempDir(t, 'builder-call-');
  const home = path.join(dir, 'home'); // 隔离数据根:生成的命令不带 --registry,靠 DASHBOARD_HOME 认注册表
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  const reg = path.join(home, 'registry.json');
  cmds.register({ id: 'p1', name: '施工方式新接口', root: repo, registry: reg });
  cmds.add({ project: 'p1', registry: reg, _: ['DISP-1'], title: '派单生成链路的临时卡' });

  // 生成任务书:CLI 前缀必须指向本检出的代码,别让机器上恰好存在的发布副本混进来。
  const savedHookRoot = process.env.DASHBOARD_HOOK_CLI_ROOT;
  let text;
  try {
    process.env.DASHBOARD_HOOK_CLI_ROOT = CODE_ROOT;
    text = buildTaskDispatchPrompt('p1', '施工方式新接口', {
      id: 'DISP-1', title: '派单生成链路的临时卡',
      decisions: [{ id: 'd1', question: 'Q', answer: 'A', decidedAt: '2026-01-01' }],
    }, undefined);
  } finally {
    if (savedHookRoot === undefined) delete process.env.DASHBOARD_HOOK_CLI_ROOT;
    else process.env.DASHBOARD_HOOK_CLI_ROOT = savedHookRoot;
  }

  // 任务书正文里 brief 的「认领时顺手补」提示也含 claim,但带的是 --builder <施工方式> 占位符;
  // 真正给对话执行的是落地流程代码块里那条(两处都在时它排在最后)。选行判据只认结构与占位符,
  // 不认 "--builder 派单器" 字样——旧代码选出的行照样能被选中、被真执行,红必须红在真实 CLI 拒收上。
  const candidates = text.split('\n').filter((l) => l.includes('claim DISP-1 --project p1'));
  assert.ok(candidates.length, '任务书里有 claim DISP-1 的命令行');
  const line = candidates[candidates.length - 1];
  assert.ok(!line.includes('<施工方式>') && !line.includes('`'), '选中的应是代码块里的那条,不是占位模板');

  // 先按既有隔离环境真实执行(生成的命令不带 --registry,靠 DASHBOARD_HOME 认注册表;占位替换成真分支)。
  const cmd = line.replace('<你的分支名>', 'feat/disp-1');
  const r = spawnSync(cmd, {
    shell: true, encoding: 'utf8', cwd: repo, timeout: 120000, windowsHide: true,
    env: {
      ...process.env,
      DASHBOARD_HOME: home,
      DASHBOARD_HOOK_CLI_ROOT: CODE_ROOT,
      DASHBOARD_RELEASE_HOME: path.join(dir, 'release'),
      DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'),
    },
  });
  assert.equal(r.status, 0, `生成的 claim 命令真执行必须成功(旧代码生成的命令缺必填 --builder,会被真实 CLI 在闸上拒收、在这里红):\n${r.stderr || r.stdout}`);
  const board = JSON.parse(fs.readFileSync(path.join(repo, '.dashboard', 'board.json'), 'utf8'));
  const card = board.tasks.find((x) => x.id === 'DISP-1');
  assert.equal(card.status, '施工中', '占位替换后真执行,卡真的认领成功');
  assert.equal(card.builder, '派单器', '施工方式落卡');
  const act = board.activity.find((a) => a.type === 'claim' && a.taskId === 'DISP-1');
  assert.equal(act && act.builder, '派单器', '同一条认领流水带施工方式');
  // 真执行过了再补参数字样验证:不许拿它替代真执行,更不许让它抢在真执行前把旧码短路成"假红"。
  assert.ok(line.includes('--builder 派单器'), `派出的 claim 模板要明写施工方式=派单器:\n${line}`);
});

test('hook-timing 在隔离测量环境真跑:四条计时命令照常出数,不因缺 --builder 中断', (t) => {
  const dir = tempDir(t, 'builder-timing-');
  // 脚本自建临时 git 仓/注册表并隔离 git 配置(GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL),
  // 这里再把数据根挪进临时目录,双保险不触生产板与全局配置。
  const r = spawnSync(process.execPath, [path.join(CODE_ROOT, 'scripts', 'hook-timing.cjs'), '--project', 'callers-timing'], {
    encoding: 'utf8', timeout: 600000, windowsHide: true,
    env: { ...process.env, DASHBOARD_HOME: path.join(dir, 'home') },
  });
  assert.equal(r.status, 0, `hook-timing 应完整跑完(旧代码的临时卡认领缺 --builder 会死在 claim):\n${r.stderr || r.stdout}`);
  assert.ok(!String(r.stderr).includes('缺 --builder'), '不许报缺施工方式');
  for (const row of ['claim-check', 'sync-progress', 'doctor --quick --quiet', 'doctor --quiet', '中位数(ms)']) {
    assert.ok(r.stdout.includes(row), `实际测量输出要保留:${row}`);
  }
});
