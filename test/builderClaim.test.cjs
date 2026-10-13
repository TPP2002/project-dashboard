'use strict';
/**
 * builderClaim.test.cjs —— claim --builder 必填机器闸的回归门禁(DASH-CLAIM-BUILDER-GATE-1010)。
 *
 * 治的病:claim 此前不问「这活是谁派的」——缺 --builder 照样落卡开工,施工方式在卡上
 * 与认领流水里都无迹可查。本文件锁死新规矩:
 *   · claim 必填 --builder,合法值严格五选一(下面逐字写死,刻意不 require 生产那份枚举:
 *     旧代码上这些用例要红在【行为】上——旧 claim 缺 --builder 照样放行——而不是红在加载失败):
 *       派单器 / 自干:例外① / 自干:例外② / 自干:例外③ / 自干:例外④
 *     缺省、裸 flag、空串、编号外(全角冒号/裸「自干」/编号⑤/别的平台名)一律拒收,
 *     报错给可复制模板,且一个字段都不写。
 *   · 认领通过时施工方式落进卡的 builder 字段,同一条 claim 活动流水也带上它。
 *   · 旧卡没有 builder 字段照常读、列表显「未标」;list --builder 按值精确筛选;
 *     绕过 claim 用 set 塞非法值,架构校验也要拦。
 *   · 自干例外的「为什么符合例外」以本卡留言(note 命令)为证据,且要明确写明
 *     「施工方=<施工方式>;理由=<…>」的清晰格式(与提示给的可复制样式一致),普通留言不算:
 *     缺证据 done 只提示不拦收官;--collect 不提示;cost 硬闸照旧在入口拦没记账的 done。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const CLI = path.resolve(__dirname, '../cli/index.cjs');
/** 合法值契约:一字不差的五个。故意在测试里重写一遍,别改成 require 生产枚举。 */
const VALUES = ['派单器', '自干:例外①', '自干:例外②', '自干:例外③', '自干:例外④'];
/** 拒收文案必须给全的可复制模板要素。 */
const TEMPLATE_MARKS = ['可复制模板', '派单器', '自干:例外①', '--builder', 'claim <卡号>'];

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } });
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: '施工方式闸', root, registry: reg });
  return { dir, reg, root, board: path.join(root, '.dashboard', 'board.json'), P: { project: 't', registry: reg } };
}

/** 真实 CLI 跑一条命令;红绿判断交给用例。 */
function cli(f, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--registry', f.reg], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}
const addCard = (f, id) => cmds.add({ _: [id], title: `${id} 的技术说明`, ...f.P });
const rawBoard = (f) => fs.readFileSync(f.board, 'utf8');
const taskOf = (f, id) => JSON.parse(rawBoard(f)).tasks.find((x) => x.id === id);

test('缺 --builder:真 CLI 拒收、报错给可复制模板、板上一个字节都不动', (t) => {
  const f = setup(t);
  addCard(f, 'T1');
  const before = rawBoard(f);
  const r = cli(f, ['claim', 'T1', '--project', 't', '--branch', 'feat/a']);
  assert.equal(r.status, 1, '缺 --builder 必须拒收(旧代码这里退出码 0)');
  assert.match(r.stderr, /✖/, '错误走 stderr');
  assert.match(r.stderr, /缺 --builder/);
  for (const mark of TEMPLATE_MARKS) assert.ok(r.stderr.includes(mark), `拒收文案要含「${mark}」`);
  assert.equal(rawBoard(f), before, '拒收零写入');
});

test('裸 --builder(后头没跟值)同样拒收', (t) => {
  const f = setup(t);
  addCard(f, 'T1');
  const before = rawBoard(f);
  const r = cli(f, ['claim', 'T1', '--project', 't', '--branch', 'feat/a', '--builder']);
  assert.equal(r.status, 1, '裸 flag 必须拒收');
  assert.match(r.stderr, /缺 --builder/);
  assert.equal(rawBoard(f), before);
});

test('编号外的值(全角冒号/裸「自干」/编号⑤/别的平台名)一律拒收,报错原样回显并给全模板', (t) => {
  const f = setup(t);
  addCard(f, 'T1');
  const before = rawBoard(f);
  for (const bad of ['自干：例外①', '自干', '自干:例外⑤', 'codex', 'dispatcher']) {
    const r = cli(f, ['claim', 'T1', '--project', 't', '--branch', 'feat/a', '--builder', bad]);
    assert.equal(r.status, 1, `「${bad}」不在五选一里,必须拒`);
    assert.match(r.stderr, /--builder 非法/);
    assert.ok(r.stderr.includes(`「${bad}」`), '报错要原样回显收到的值');
    for (const mark of TEMPLATE_MARKS) assert.ok(r.stderr.includes(mark), `非法值报错同样要含「${mark}」`);
  }
  assert.equal(rawBoard(f), before, '非法值一个字段都不写');
});

test('五个合法值逐一放行:builder 落卡,同一条 claim 流水也带施工方式,认领文本保持原样', (t) => {
  const f = setup(t);
  VALUES.forEach((v, i) => addCard(f, `V${i}`));
  VALUES.forEach((v, i) => {
    const r = cli(f, ['claim', `V${i}`, '--project', 't', '--branch', `feat/v${i}`, '--builder', v]);
    assert.equal(r.status, 0, r.stderr);
    const card = taskOf(f, `V${i}`);
    assert.equal(card.status, '施工中');
    assert.equal(card.builder, v, `builder 要原样落卡:${v}`);
  });
  const acts = JSON.parse(rawBoard(f)).activity.filter((a) => a.type === 'claim');
  assert.equal(acts.length, VALUES.length);
  VALUES.forEach((v, i) => {
    const a = acts.find((x) => x.taskId === `V${i}`);
    assert.equal(a.builder, v, '同一条认领流水带施工方式');
    assert.match(a.text, /^认领 V/, '认领文本保持原样(别的模块按它解析分支)');
  });
});

test('旧卡没有 builder 字段:照常读、默认列表照常出现,--fields builder 显「未标」', (t) => {
  const f = setup(t);
  addCard(f, 'OLD1'); // 不 claim:本规矩生效前的老卡没有 builder
  const listed = cli(f, ['list', '--project', 't', '--fields', 'id,builder']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /OLD1\s+未标/, '缺字段显示「未标」,不许开天窗');
  const plain = cli(f, ['list', '--project', 't']);
  assert.equal(plain.status, 0);
  assert.ok(plain.stdout.includes('OLD1'), '老卡照常出现在默认列表');
});

test('list --builder 按值精确筛选:别的施工方式与没标的都不进结果;裸 flag 与编号外拒收', (t) => {
  const f = setup(t);
  addCard(f, 'A1'); addCard(f, 'A2'); addCard(f, 'A3');
  assert.equal(cli(f, ['claim', 'A1', '--project', 't', '--branch', 'b1', '--builder', '派单器']).status, 0);
  assert.equal(cli(f, ['claim', 'A2', '--project', 't', '--branch', 'b2', '--builder', '自干:例外①']).status, 0);
  const disp = cli(f, ['list', '--project', 't', '--builder', '派单器']);
  assert.equal(disp.status, 0, disp.stderr);
  assert.ok(disp.stdout.includes('A1'));
  assert.ok(!disp.stdout.includes('A2') && !disp.stdout.includes('A3'), '其它施工方式与没标的都不进这个筛选');
  const self = cli(f, ['list', '--project', 't', '--builder', '自干:例外①']);
  assert.equal(self.status, 0);
  assert.ok(self.stdout.includes('A2') && !self.stdout.includes('A1'));
  const bad = cli(f, ['list', '--project', 't', '--builder', '自干']);
  assert.equal(bad.status, 1, '裸「自干」不是合法值');
  assert.match(bad.stderr, /--builder 非法/);
  const bare = cli(f, ['list', '--project', 't', '--builder']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /缺值|合法值/);
});

test('自干例外缺理由:done 只提示不拦收官,提示里给可直接复制的留痕命令', (t) => {
  const f = setup(t);
  addCard(f, 'S1');
  cli(f, ['claim', 'S1', '--project', 't', '--branch', 'feat/s1', '--builder', '自干:例外③']);
  assert.equal(cli(f, ['done', 'S1', '--project', 't']).status, 1, '没记账先被 cost 硬闸拦(与本闸无关)');
  assert.equal(cli(f, ['cost', 'S1', '--project', 't', '--agents', 'sonnet:1', '--tokens', '1000']).status, 0);
  const done = cli(f, ['done', 'S1', '--project', 't']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /已完工/, '只提示,不拦收官');
  assert.match(done.stdout, /⚠/);
  assert.match(done.stdout, /自干:例外③/);
  assert.match(done.stdout, /为什么符合例外/);
  assert.match(done.stdout, /note S1/, '提示要给留痕命令');
  assert.match(done.stdout, /不拦收官/);
});

test('有本卡留言作证据就不再提示;认领流水本身不算理由', (t) => {
  const f = setup(t);
  addCard(f, 'S2'); addCard(f, 'S3');
  cli(f, ['claim', 'S2', '--project', 't', '--branch', 'feat/s2', '--builder', '自干:例外②']);
  cli(f, ['claim', 'S3', '--project', 't', '--branch', 'feat/s3', '--builder', '自干:例外②']);
  cli(f, ['cost', 'S2', '--project', 't', '--agents', 'sonnet:1', '--tokens', '1000']);
  cli(f, ['cost', 'S3', '--project', 't', '--agents', 'sonnet:1', '--tokens', '1000']);
  const s2 = cli(f, ['done', 'S2', '--project', 't']);
  assert.equal(s2.status, 0, s2.stderr);
  assert.match(s2.stdout, /为什么符合例外/, '光认领不算理由:卡上只有流水、没有留言,此时要提示');
  assert.equal(cli(f, ['note', 'S3', '--project', 't', '--text', '施工方=自干:例外②;理由=对上开工须知例外表第②条']).status, 0);
  const s3 = cli(f, ['done', 'S3', '--project', 't']);
  assert.equal(s3.status, 0, s3.stderr);
  assert.ok(!s3.stdout.includes('为什么符合例外'), '有留言证据就不再提示');
});

test('普通留言不算理由:没写明例外与理由(闲聊/只写施工方没写理由/写了别的编号)照样提醒,done 均成功', (t) => {
  const f = setup(t);
  for (const id of ['N1', 'N2', 'N3']) addCard(f, id);
  cli(f, ['claim', 'N1', '--project', 't', '--branch', 'feat/n1', '--builder', '自干:例外①']);
  cli(f, ['claim', 'N2', '--project', 't', '--branch', 'feat/n2', '--builder', '自干:例外①']);
  cli(f, ['claim', 'N3', '--project', 't', '--branch', 'feat/n3', '--builder', '自干:例外①']);
  assert.equal(cli(f, ['note', 'N1', '--project', 't', '--text', 'CI还在排队,先等一会再交活']).status, 0);
  assert.equal(cli(f, ['note', 'N2', '--project', 't', '--text', '施工方=自干:例外①']).status, 0);
  assert.equal(cli(f, ['note', 'N3', '--project', 't', '--text', '施工方=自干:例外④;理由=写了别的编号也不算']).status, 0);
  for (const id of ['N1', 'N2', 'N3']) {
    assert.equal(cli(f, ['cost', id, '--project', 't', '--agents', 'sonnet:1', '--tokens', '1000']).status, 0);
    const done = cli(f, ['done', id, '--project', 't']);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.match(done.stdout, /已完工/, '提醒不拦收官');
    assert.match(done.stdout, /为什么符合例外/, `${id} 的留言没写明本卡例外与理由,要照样提醒`);
  }
});

test('--collect 转「收官」不给自干理由提示;派单器的卡收官也不掺和', (t) => {
  const f = setup(t);
  addCard(f, 'C1'); addCard(f, 'D1');
  cli(f, ['claim', 'C1', '--project', 't', '--branch', 'feat/c1', '--builder', '自干:例外④']);
  cli(f, ['claim', 'D1', '--project', 't', '--branch', 'feat/d1', '--builder', '派单器']);
  const c = cli(f, ['done', 'C1', '--project', 't', '--collect']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /收官/);
  assert.ok(!c.stdout.includes('为什么符合例外'), '--collect 还没到收官那一步,不给提示');
  assert.equal(cli(f, ['cost', 'D1', '--project', 't', '--agents', 'sonnet:1', '--tokens', '1000']).status, 0);
  const d = cli(f, ['done', 'D1', '--project', 't']);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(!d.stdout.includes('为什么符合例外'), '派单器的卡不该被自干提示扫到');
});

test('cost 硬闸照旧:没记账的 done 先在入口被拦,拒收文案里没有 builder 的事', (t) => {
  const f = setup(t);
  addCard(f, 'G1');
  cli(f, ['claim', 'G1', '--project', 't', '--branch', 'feat/g1', '--builder', '自干:例外①']);
  const r = cli(f, ['done', 'G1', '--project', 't']);
  assert.equal(r.status, 1, 'cost 硬闸必须还在');
  assert.match(r.stderr, /开销/);
  assert.ok(!r.stderr.includes('为什么符合例外'), 'builder 提示不掺和 cost 闸');
});

test('编程调用同样被闸:缺参/空串/非法值 throws 且零写入;set 绕道塞非法值被架构校验拦', (t) => {
  const f = setup(t);
  addCard(f, 'P1');
  const before = rawBoard(f);
  assert.throws(() => cmds.claim({ _: ['P1'], branch: 'feat/p1', ...f.P }), /缺 --builder/);
  assert.throws(() => cmds.claim({ _: ['P1'], branch: 'feat/p1', builder: '', ...f.P }), /缺 --builder/);
  assert.throws(() => cmds.claim({ _: ['P1'], branch: 'feat/p1', builder: '自干:例外⑤', ...f.P }), /--builder 非法/);
  assert.equal(rawBoard(f), before, '三次拒收都零写入');
  assert.throws(
    () => cmds.set({ _: ['P1'], field: 'builder', value: JSON.stringify('自干:例外⑤'), ...f.P }),
    /builder/, '绕过 claim 直改也要被架构校验拦下',
  );
  assert.equal(rawBoard(f), before, 'set 被拒同样零写入');
  cmds.set({ _: ['P1'], field: 'builder', value: JSON.stringify('派单器'), ...f.P });
  assert.equal(taskOf(f, 'P1').builder, '派单器', '合法值经 set 放行(补登记口)');
});

test('help / protocol / brief 三处说明都带上 --builder,老卡在任务书里显「未标」不静默留白', (t) => {
  const f = setup(t);
  const help = cli(f, ['help', 'claim']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--builder/);
  assert.match(help.stdout, /派单器/);
  assert.match(help.stdout, /自干:例外①/);
  const proto = cli(f, ['protocol', '--project', 't']);
  assert.equal(proto.status, 0);
  assert.match(proto.stdout, /--builder 必填机器闸/);
  assert.match(proto.stdout, /自干:例外①~④/);
  assert.match(proto.stdout, /claim [^\n]*--builder 派单器/, '示例命令本身可照抄');
  addCard(f, 'B1');
  const b = cli(f, ['brief', 'B1', '--project', 't']);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /施工方式/);
  assert.match(b.stdout, /未标/, '没标的卡要明说,不许静默留白');
  assert.match(b.stdout, /--builder/, '补齐路子/开工命令里要有 --builder');
});
