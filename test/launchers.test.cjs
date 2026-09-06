'use strict';
/**
 * launchers.test.cjs —— 启动器只许从发布副本起服务(SERVER-RUNS-ON-LIVE-CHECKOUT T2)。
 *
 * 这一条靠人守必失守:谁顺手把 `node server/server.cjs` 加回启动器,负责人就又在看"别人正在改的那份代码",
 * 而且看不出来。所以做成机器闸:
 *   · 启动器里不许出现"直接起本检出 server"的写法;
 *   · 必须问 `release --print-dest` 要副本目录,并从那里起服务;
 *   · 必须先发布(cli release),发布失败要么退回上一份副本、要么停,绝不回落到本检出;
 *   · 落脚点纪律:启动器不许 cd 进发布副本(Windows 上那样会锁住目录,下次发布换名必 EBUSY)。
 * serviceStatus 的"没在跑"口径一并钉住:探不到不许报错,更不许假装在跑。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

for (const f of ['启动看板.bat', 'dashboard.sh']) {
  test(`${f}:从发布副本起服务,不碰本检出的 server`, () => {
    const s = read(f);
    assert.ok(!/node\s+"?server[\\/]server\.cjs/.test(s), '不许直接起本检出的 server —— 那正是本卡要治的病');
    assert.match(s, /release --print-dest/, '必须问 CLI 要发布副本目录,别自己拼路径');
    assert.match(s, /server[\\/]server\.cjs/, '总得起服务');
    assert.match(s, /(REL|\$REL)/, '起服务用的必须是副本目录变量');
    assert.match(s, /index\.cjs release\b/, '起服务前必须先发布一次');
  });

  test(`${f}:发布失败不许回落到本检出;也不许 cd 进副本`, () => {
    const s = read(f);
    assert.match(s, /上一次发布好的那份|上一份/, '发布失败要说清"用的是上一份副本"');
    assert.ok(!/cd\s+[/\\]d?\s*"?%REL%|cd\s+"\$REL"/.test(s), '不许把当前目录切进发布副本(会锁住目录,下次发布换名必失败)');
  });
}

test('serviceStatus:探不到服务时如实说"没在跑",不报错也不瞎猜', () => {
  const { serviceStatus } = require('../cli/release.cjs');
  const st = serviceStatus({ portBase: 39871, portRange: 0 }); // 没人会在这个端口上跑看板
  assert.equal(st.running, false);
  assert.match(st.text, /没在跑/);
});
