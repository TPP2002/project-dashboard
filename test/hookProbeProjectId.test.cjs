'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const { doctor } = require('../cli/gitSync.cjs');
const cmds = require('../cli/commands.cjs');

// 安装端到端只使用本检出的 CLI，registry 则逐次显式传入临时路径。
process.env.DASHBOARD_HOOK_CLI_ROOT = path.resolve(__dirname, '..');

function tempDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-probe-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

function setup(t) {
  const dir = tempDir(t);
  const repo = path.join(dir, 'repo');
  const registry = path.join(dir, 'registry.json');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore', windowsHide: true });
  for (const id of ['alpha', 'beta']) {
    const root = path.join(dir, id);
    fs.mkdirSync(root);
    cmds.register({ id, root, registry });
  }
  const reg = JSON.parse(fs.readFileSync(registry, 'utf8'));
  for (const project of Object.values(reg.projects)) project.codeRepo = repo;
  fs.writeFileSync(registry, JSON.stringify(reg));
  return { repo, registry, hook: path.join(repo, '.git', 'hooks', 'post-commit') };
}

function block(id) {
  return `#!/bin/sh\n#dashboard-hook:begin:${id}\nnode "/test/cli/index.cjs" sync-from-git --project "${id}" || true\n#dashboard-hook:end\n`;
}

test('共用仓假绿：只装 alpha 时，beta 的 doctor 必须报未装', (t) => {
  const f = setup(t);
  fs.writeFileSync(f.hook, block('alpha'));
  // 先走已有 doctor，让改前红灯直接证明假绿，而不是被尚未新增的模块挡住。
  const beta = doctor({ project: 'beta', registry: f.registry });
  assert.match(beta.text, /未装/, '只有 alpha 的同步块，beta 必须报未装');
  assert.equal(beta.ok, false);
  assert.match(beta.text, /hooksInstall/);
  const alpha = doctor({ project: 'alpha', registry: f.registry });
  assert.doesNotMatch(alpha.text, /未装/);
  assert.equal(alpha.ok, true);
  const { hookInstalledFor } = require('../core/hookProbe.cjs');
  assert.equal(hookInstalledFor(f.repo, 'beta'), false);
  assert.equal(hookInstalledFor(f.repo, 'alpha'), true);
});

test('项目锚独立成立；rogue 与 rogue2、rog 以及标识符后缀互不混淆', () => {
  const { hookForwardsProject } = require('../core/hookProbe.cjs');
  const text = '#dashboard-hook:begin:rogue\n#dashboard-hook:end\n';
  assert.equal(hookForwardsProject(text, 'rogue'), true);
  for (const id of ['rogue2', 'rog']) assert.equal(hookForwardsProject(text, id), false);
  for (const suffix of ['2', 'A', 'z', '_', '.', '-']) {
    assert.equal(hookForwardsProject(`#dashboard-hook:begin:rogue${suffix}`, 'rogue'), false);
  }
});

for (const quote of ['"', "'", '']) {
  test(`调用参数兼容 ${quote || '裸值'}，项目 id 前缀不能误判`, () => {
    const { hookForwardsProject } = require('../core/hookProbe.cjs');
    const call = (id) => `node "/test/cli/index.cjs" sync-from-git --project ${quote}${id}${quote} || true`;
    assert.equal(hookForwardsProject(call('rogue'), 'rogue'), true);
    for (const id of ['rogue2', 'rog']) assert.equal(hookForwardsProject(call('rogue'), id), false);
    for (const suffix of ['2', 'A', 'z', '_', '.', '-']) {
      assert.equal(hookForwardsProject(call('rogue' + suffix), 'rogue'), false);
    }
  });
}

test('旧版无 id 锚依靠 --project "alpha" 仍可识别', () => {
  const { hookForwardsProject } = require('../core/hookProbe.cjs');
  const text = block('alpha').replace('#dashboard-hook:begin:alpha', '#dashboard-hook:begin');
  assert.equal(hookForwardsProject(text, 'alpha'), true);
  assert.equal(hookForwardsProject(text, 'beta'), false);
});

test('项目 id 中的正则元字符按字面匹配', () => {
  const { hookForwardsProject } = require('../core/hookProbe.cjs');
  const id = 'a.b+[x](y){2}^$|?*\\z';
  assert.equal(hookForwardsProject(`#dashboard-hook:begin:${id}\n`, id), true);
  assert.equal(hookForwardsProject(`node cli sync-from-git --project "${id}"`, id), true);
  assert.equal(hookForwardsProject('#dashboard-hook:begin:aXb', 'a.b'), false);
  assert.equal(hookForwardsProject('node cli sync-from-git --project aXb', 'a.b'), false);
});

test('空值、非字符串和只有 dashboard 字样不算安装', (t) => {
  const { hookForwardsProject, hookInstalledFor } = require('../core/hookProbe.cjs');
  for (const text of ['', null, undefined, 42, {}, Buffer.from('alpha')]) {
    assert.equal(hookForwardsProject(text, 'alpha'), false);
  }
  for (const id of ['', ' ', null, undefined, 42]) assert.equal(hookForwardsProject(block('alpha'), id), false);
  assert.equal(hookForwardsProject('# dashboard sync\n#dashboard-hook:begin\n', 'alpha'), false);
  const f = setup(t);
  const missing = doctor({ project: 'alpha', registry: f.registry });
  assert.match(missing.text, /hook 未安装/);
  fs.writeFileSync(f.hook, '#!/bin/sh\n# dashboard sync\n');
  const noProject = doctor({ project: 'alpha', registry: f.registry });
  assert.equal(noProject.ok, false);
  assert.match(noProject.text, /未装/);
  assert.equal(hookInstalledFor(f.repo, 'alpha'), false);
});

for (const absolute of [false, true]) {
  test(`.git 指针解析 ${absolute ? '绝对' : '相对'} gitdir`, (t) => {
    const { hookInstalledFor } = require('../core/hookProbe.cjs');
    const dir = tempDir(t);
    const repo = path.join(dir, 'checkout');
    const gitDir = path.join(dir, 'git metadata');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${absolute ? gitDir : path.relative(repo, gitDir)}\r\n`);
    fs.writeFileSync(path.join(gitDir, 'hooks', 'post-commit'), block('alpha'));
    assert.equal(hookInstalledFor(repo, 'alpha'), true);
    assert.equal(hookInstalledFor(repo, 'beta'), false);
  });
}

test('无仓、无 hook、坏指针或 hook 读失败均返回 false，不抛异常', (t) => {
  const { hookInstalledFor } = require('../core/hookProbe.cjs');
  const repo = tempDir(t);
  for (const invalid of [null, undefined, 42, path.join(repo, 'absent'), repo]) {
    assert.equal(hookInstalledFor(invalid, 'alpha'), false);
  }
  const gitPath = path.join(repo, '.git');
  for (const pointer of ['not a git pointer', 'gitdir:   \n', 'gitdir: missing\n']) {
    fs.writeFileSync(gitPath, pointer);
    assert.equal(hookInstalledFor(repo, 'alpha'), false);
  }
  fs.unlinkSync(gitPath);
  fs.mkdirSync(path.join(gitPath, 'hooks'), { recursive: true });
  assert.equal(hookInstalledFor(repo, 'alpha'), false);
  fs.mkdirSync(path.join(gitPath, 'hooks', 'post-commit'));
  assert.equal(hookInstalledFor(repo, 'alpha'), false);
});

test('hooksInstall 端到端：给共用仓的 alpha、beta 各安装一次后均已装', (t) => {
  const f = setup(t);
  const { hookInstalledFor } = require('../core/hookProbe.cjs');
  hooksInstall({ project: 'alpha', registry: f.registry });
  assert.equal(hookInstalledFor(f.repo, 'alpha'), true);
  assert.equal(hookInstalledFor(f.repo, 'beta'), false);
  hooksInstall({ project: 'beta', registry: f.registry });
  for (const id of ['alpha', 'beta']) {
    assert.equal(hookInstalledFor(f.repo, id), true);
    assert.doesNotMatch(doctor({ project: id, registry: f.registry }).text, /未装/);
  }
});
