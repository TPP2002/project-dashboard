'use strict';
/**
 * AUD-CLI-BRIEF-AND-HELP · 逐命令帮助的回归门禁(审计 §4-A1)。
 * 病根:全局 help 只罗列命令名,`pending --help` 会被 need() 当成"缺参数 --project"报错——
 * 而 AGENTS.md 明写让 AI 去看 `pending --help`,照做必失败、白跑一整轮。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const help = require('../cli/help.cjs');
const { REGISTRY } = require('../cli/index.cjs');

const CLI = path.join(__dirname, '..', 'cli', 'index.cjs');
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
}

test('注册表里每条命令都有帮助条目(新增命令漏写帮助会当场红)', () => {
  const missing = Object.keys(REGISTRY).filter((cmd) => !help.COMMANDS[cmd]);
  assert.deepEqual(missing, [], '这些命令还没写帮助');
  const extra = Object.keys(help.COMMANDS).filter((cmd) => !REGISTRY[cmd]);
  assert.deepEqual(extra, [], '这些帮助条目已经没有对应命令了');
});

test('每条帮助都有一句话、用法行、参数表、示例、退出码', () => {
  for (const [cmd, entry] of Object.entries(help.COMMANDS)) {
    assert.ok(entry.summary && entry.summary.length >= 4, `${cmd} 缺一句话说明`);
    assert.ok(entry.usage && entry.usage.startsWith(cmd), `${cmd} 的用法行要以命令名开头`);
    assert.ok(Array.isArray(entry.args) && entry.args.length, `${cmd} 缺参数表`);
    assert.ok(Array.isArray(entry.examples) && entry.examples.length, `${cmd} 缺示例`);
    const text = help.renderCommandHelp(cmd);
    for (const section of ['用法', '参数', '示例', '退出码']) {
      assert.ok(text.includes(section), `${cmd} 的帮助缺【${section}】段`);
    }
    assert.ok(text.split('\n').length <= 40, `${cmd} 的帮助超过一屏(${text.split('\n').length} 行)`);
  }
});

test('全局 help 列出全部命令,每条带一句话', () => {
  const text = help.renderGlobalHelp();
  for (const cmd of Object.keys(REGISTRY)) {
    assert.ok(text.includes(cmd), `全局 help 漏了 ${cmd}`);
  }
  assert.ok(text.includes(help.COMMANDS.claim.summary), '全局 help 要带一句话说明,不能只有命令名');
  assert.match(text, /--help/, '要告诉调用方怎么看单条命令的详细用法');
});

test('protocol 帮助说明可选项目与两种格式，并在开工组排在 brief 前', () => {
  const r = run(['protocol', '--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /protocol \[--project <id>\] \[--format md\|json\]/);
  assert.match(r.stdout, /占位符/);
  const group = help.GROUPS.find(([title]) => title.includes('开工与同步'));
  assert.deepEqual(group[1].slice(0, 2), ['protocol', 'brief']);
});

test('pending --help 给用法,不再报"缺参数 --project"(AGENTS.md 照着写的那条路要真的通)', () => {
  const r = run(['pending', '--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /用法/);
  assert.match(r.stdout, /background|三件套/, 'pending 的帮助要点明三件套');
  assert.ok(!/缺参数/.test(r.stdout + r.stderr), '不许再把 --help 当成缺参数');
});

test('add --help 不被建卡机器闸拦下(闸门只该拦真建卡)', () => {
  const r = run(['add', '--help']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /--plain-title/);
  assert.ok(!/✖ 建卡必须带/.test(r.stdout + r.stderr));
});

test('-h 与 help <命令> 与 <命令> --help 三种写法等价', () => {
  const a = run(['claim', '--help']).stdout;
  const b = run(['claim', '-h']).stdout;
  const c = run(['help', 'claim']).stdout;
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /claim <卡号>/);
});

test('裸 help / 无参数 给全局帮助,退出码 0', () => {
  for (const args of [[], ['help'], ['--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, JSON.stringify(args) + r.stderr);
    assert.match(r.stdout, /命令一览|全部命令/);
  }
});

test('help <不存在的命令> 报错并给可用命令,退出码 2', () => {
  const r = run(['help', 'nosuchcmd']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nosuchcmd/);
});

test('每条帮助的示例都用统一的调用前缀,不写死某台机器的路径', () => {
  for (const [cmd, entry] of Object.entries(help.COMMANDS)) {
    for (const ex of entry.examples) {
      assert.ok(!/[A-Za-z]:[\\/]/.test(ex), `${cmd} 的示例里不许出现盘符路径:${ex}`);
      assert.ok(ex.startsWith(cmd + ' ') || ex === cmd, `${cmd} 的示例要以命令名开头:${ex}`);
    }
  }
});
