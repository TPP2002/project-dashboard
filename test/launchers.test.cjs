'use strict';
/**
 * launchers.test.cjs —— 启动器只许从发布副本起服务(SERVER-RUNS-ON-LIVE-CHECKOUT T2)。
 *
 * 这一条靠人守必失守:谁顺手把 `node server/server.cjs` 加回启动链,负责人就又在看"别人正在改的那份代码",
 * 而且看不出来。所以做成机器闸。自 DASH-LAUNCHER-NO-SCHED-HOLD-1012 起,整条编排都搬进了
 * cli/launcher.cjs,启动看板.bat / dashboard.sh 只是薄入口 —— 断言跟着责任走:
 *   · 薄入口只许检查 Node 后把整条链交给 cli/launcher.cjs,自己不起 server、不发布;
 *   · 启动器的副本目录必须用与 cli release 同一份 releaseHome() 判据,不许自己拼路径;
 *   · 必须先发布(cli release),副本 CLI 在就优先用它,本检出只当 --source;
 *   · 发布失败要么退回上一次发布好的副本、要么停,绝不回落到本检出的 server;
 *   · 服务只能起发布副本里的 server/server.cjs,副本里没有就明确拒绝;
 *   · 落脚点纪律:薄入口与启动器都不许把当前目录切进发布副本(那样会锁住目录,下次发布换名必 EBUSY)。
 * serviceStatus 的"没在跑"口径一并钉住:探不到不许报错,更不许假装在跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const f of ['启动看板.bat', 'dashboard.sh']) {
  test(`${f}:薄入口不起服务,整条链交给 cli/launcher.cjs`, () => {
    const s = read(f);
    assert.ok(!/node\s+"?server[\\/]server\.cjs/.test(s), '不许直接起本检出的 server —— 那正是本卡要治的病');
    assert.match(s, /cli[\\/]launcher\.cjs/, '薄入口必须把整条编排交给 cli/launcher.cjs');
  });

  test(`${f}:薄入口不许 cd 进发布副本`, () => {
    const s = read(f);
    assert.ok(!/cd\s+[/\\]d?\s*"?%REL%|cd\s+"\$REL"/.test(s), '不许把当前目录切进发布副本(会锁住目录,下次发布换名必失败)');
  });
}

const launcher = read('cli/launcher.cjs');

test('launcher:从发布副本起服务,不碰本检出的 server', () => {
  assert.ok(!/node\s+"?server[\\/]server\.cjs/.test(launcher), '不许直接起本检出的 server —— 那正是本卡要治的病');
  assert.match(launcher, /releaseHome\(/, '副本目录必须用与 cli release 同一份 releaseHome() 判据,别自己拼路径');
  assert.match(launcher, /d\.relHome,\s*'server',\s*'server\.cjs'/, '总得起服务,而且只能起发布副本里的 server');
  assert.ok(!/codeRoot,\s*'server'/.test(launcher), '服务代码绝不许回落到本检出');
});

test('launcher:起服务前必须先发布一次;发布优先用副本自己的 CLI(本检出可能落后,旧发布工具建不出界面)', () => {
  const copyCli = launcher.search(/fs\.existsSync\(relCli\)\s*\?\s*relCli\s*:/);
  const releaseCmd = launcher.search(/'release',\s*'--source',\s*d\.codeRoot/);
  const serve = launcher.search(/d\.relHome,\s*'server',\s*'server\.cjs'/);
  assert.ok(copyCli !== -1, '副本在就用副本自己的发布命令,并把本检出当来源');
  assert.ok(releaseCmd !== -1, '必须经 cli release 发布(副本 CLI 不在时才用本检出的命令引导一次)');
  assert.ok(serve !== -1 && releaseCmd !== -1 && releaseCmd < serve, '起服务前必须先发布一次');
});

test('launcher:发布失败不许回落到本检出;也不许把当前目录切进副本', () => {
  assert.match(launcher, /上一次发布好的那份/, '发布失败要说清"用的是上一次发布好的副本"');
  assert.ok(!/process\.chdir/.test(launcher), '不许把当前目录切进发布副本(会锁住目录,下次发布换名必失败)');
});

test('serviceStatus:探不到服务时如实说"没在跑",不报错也不瞎猜', () => {
  const { serviceStatus } = require('../cli/release.cjs');
  const st = serviceStatus({ portBase: 39871, portRange: 0 }); // 没人会在这个端口上跑看板
  assert.equal(st.running, false);
  assert.match(st.text, /没在跑/);
});
