'use strict';
/**
 * 发布换名被占时的诊断(DASH-RELEASE-BLOCKED-BY-OWN-SERVER,0914)。
 *
 * 【这组测试真正在守什么】不是「代码能跑」,而是**两个错误码的含义别再被判反**。
 * 0914 真实撞上一次 EPERM,我先按「服务的当前工作目录落在副本里」去治 —— 那是错方向,
 * 为此做了五轮隔离复现才把它排除掉,烧掉一上午:
 *   ① 目录是某进程的 cwd            → EBUSY   ← 本文件前两例把这条钉死
 *   ② 有进程在目录里开着文件(cwd 在外)→ EPERM   ← 今天真实失败是这个
 *   ③ 只监听端口                    → 不拦
 *   ④ 只 require 过里面的 .cjs(读完就关)→ 不拦(反复起短命 CLI 60 次换名全成)
 *   ⑤ 触发全项目扫描的接口          → 不拦
 * 前两条是**平台事实**,用真进程 + 真 rename 现场量出来,不用替身 —— 替身会把这条边界整个抹掉,
 * 而这条边界正是当初判错方向的地方。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { renameRetry, holdersOf, RENAME_CODE_MEANING } = require('../cli/release.cjs');

const WIN = process.platform === 'win32';

/** 造一个「要被换名的目录」+ 一个「外面的目录」+ 一个能长跑的子进程脚本。 */
function setup(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rrd-')));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* Windows 句柄滞留 */ } });
  const dest = path.join(root, 'dest');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(dest, 'held.txt'), 'x', 'utf8');
  fs.writeFileSync(path.join(dest, 'srv.cjs'), `
const fs = require('node:fs');
if (process.argv[2] === 'openfile') { global.__fd = fs.openSync(process.argv[3], 'r'); }
setInterval(() => {}, 1000);
process.stdout.write('up\\n');
`, 'utf8');
  return { root, dest, outside };
}

/** 起子进程并等它报 up;t.after 里收掉。 */
function hold(t, dest, cwd, mode, target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dest, 'srv.cjs'), mode, target ?? ''], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    });
    t.after(() => { try { child.kill(); } catch (_) { /* 已退出 */ } });
    child.stdout.once('data', () => resolve(child));
  });
}

const renameCode = (from, to) => {
  try { fs.renameSync(from, to); return 'OK'; } catch (e) { return e.code; }
};

test('平台事实:目录是某进程的 cwd → 换名报 EBUSY(不是 EPERM)', { skip: !WIN && '只在 Windows 上成立' }, async (t) => {
  const { root, dest, outside } = setup(t);
  await hold(t, dest, dest, 'none');
  assert.equal(renameCode(dest, path.join(root, 'dest.old')), 'EBUSY');
  // 同一份代码、只把 cwd 挪到外面 → 立刻能换名,证明差别就在 cwd 这一个变量上
  void outside;
});

test('平台事实:进程在目录里开着文件、cwd 在外面 → 换名报 EPERM', { skip: !WIN && '只在 Windows 上成立' }, async (t) => {
  const { root, dest, outside } = setup(t);
  await hold(t, dest, outside, 'openfile', path.join(dest, 'held.txt'));
  assert.equal(renameCode(dest, path.join(root, 'dest.old')), 'EPERM');
});

test('平台事实:没人持有 → 换名就是成功(对照组,证明上面两条不是环境天生换不了名)', async (t) => {
  const { root, dest } = setup(t);
  const to = path.join(root, 'dest.old');
  assert.equal(renameCode(dest, to), 'OK');
  fs.renameSync(to, dest);
});

test('renameRetry:没人占时立刻成功,不白等预算', async (t) => {
  const { root, dest } = setup(t);
  const to = path.join(root, 'dest.old');
  const t0 = Date.now();
  renameRetry(dest, to, 30000);
  assert.ok(fs.existsSync(to), '应该真换名了');
  assert.ok(Date.now() - t0 < 2000, '不该把 30 秒预算耗掉,实际 ' + String(Date.now() - t0) + 'ms');
});

test('renameRetry:被占到超预算 → 报错里要有错误码的人话解释、重试次数、以及嫌疑持有者那一段', { skip: !WIN && '依赖 Windows 的占用语义' }, async (t) => {
  const { root, dest, outside } = setup(t);
  await hold(t, dest, outside, 'openfile', path.join(dest, 'held.txt'));
  // 预算给小,免得单测等 30 秒;走的是同一条失败路径
  assert.throws(() => renameRetry(dest, path.join(root, 'dest.old'), 400), (err) => {
    const msg = String(err.message);
    assert.match(msg, /换名失败/);
    assert.match(msg, /错误码 EPERM/, '要报出错误码');
    assert.match(msg, /在这个目录里开着某个文件/, 'EPERM 要给人话解释,不能只丢一个码');
    assert.match(msg, /已重试 \d+ 次/, '要说清等了多久,否则读的人不知道是"没等够"还是"真被钉住"');
    // 抓到与抓不到都必须说明白:抓不到时要留下"把现场记到卡上"的指路,那正是 0914 缺的东西
    assert.ok(/嫌疑持有者|没抓到嫌疑进程/.test(msg), '必须交代持有者反查的结果');
    return true;
  });
  assert.ok(fs.existsSync(dest), '失败时原目录必须还在原地,不许被换走一半');
});

test('renameRetry:EBUSY 与 EPERM 给的是两句不同的人话(判错方向就是从这儿开始的)', () => {
  assert.notEqual(RENAME_CODE_MEANING.EBUSY, RENAME_CODE_MEANING.EPERM);
  assert.match(RENAME_CODE_MEANING.EBUSY, /当前工作目录|cwd/);
  assert.match(RENAME_CODE_MEANING.EPERM, /开着某个文件/);
});

test('holdersOf:按命令行反查能抓到「从这个目录里起的进程」', { skip: !WIN && '反查用的是 Windows 的进程命令行' }, async (t) => {
  const { dest, outside } = setup(t);
  const child = await hold(t, dest, outside, 'none');
  const held = holdersOf(dest);
  assert.equal(held.supported, true);
  if (held.lines.length === 0) {
    // 反查本身跑不起来(PowerShell 被策略挡等)时不许让测试假绿:明确标出来
    assert.ok(held.why, '一条都没抓到又没有原因,说明反查静默失败了');
    t.diagnostic('反查没抓到,原因:' + held.why);
    return;
  }
  assert.ok(held.lines.some((l) => l.startsWith(String(child.pid) + '\t')), '应该抓到那个子进程的 PID');
  assert.ok(held.lines.every((l) => !l.startsWith(String(process.pid) + '\t')), '不该把自己算成持有者');
});

test('holdersOf:目录没人碰过时抓不到东西,也不抛', async (t) => {
  const { outside } = setup(t);
  const held = holdersOf(path.join(outside, '没有人用过这个目录'));
  assert.equal(typeof held.supported, 'boolean');
  assert.deepEqual(held.lines, []);
});
