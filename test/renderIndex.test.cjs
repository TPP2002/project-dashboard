'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { renderIndex } = require('../cli/renderIndex.cjs');

function setup(t) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'render-index-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempRoot, '只清理本测试创建的 TEMP 子目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const docsRoot = path.join(dir, 'docs');
  fs.mkdirSync(docsRoot);
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({
    schemaVersion: '1.0', projects: { demo: { mainRepo: dir, docsRoot } },
  }), 'utf8');
  const flags = { project: 'demo', registry };
  cmds.add({ _: ['TASK-1'], title: '示例任务', ...flags });
  return { flags, indexPath: path.join(docsRoot, 'INDEX.md') };
}

function runCli(flags, extra = []) {
  return spawnSync(process.execPath, [
    path.join(__dirname, '..', 'cli', 'index.cjs'), 'render-index',
    '--project', flags.project, '--registry', flags.registry, ...extra,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

test('A2-1 缺省 INDEX 不存在时成功跳过且不创建文件', (t) => {
  const { flags, indexPath } = setup(t);
  assert.equal(fs.existsSync(indexPath), false);
  const result = renderIndex(flags);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes(indexPath));
  assert.match(result.text, /不存在.*没有 INDEX 台账.*无需渲染/);
  assert.equal(fs.existsSync(indexPath), false, '跳过不能顺手创建 INDEX');

  const cli = runCli(flags);
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stderr, '');
  assert.match(cli.stdout, /不存在.*无需渲染/);
  assert.equal(fs.existsSync(indexPath), false, '真实 CLI 入口同样不得创建 INDEX');
});

test('A2-2 已有 INDEX 缺锚时保留完整报错且不改文件', (t) => {
  const { flags, indexPath } = setup(t);
  const original = '# 人工台账\r\n这段叙事不能猜位置覆盖。  \r\n';
  fs.writeFileSync(indexPath, original, 'utf8');
  assert.throws(() => renderIndex(flags), {
    message: `INDEX 缺少 dashboard:status 锚。请在 ${indexPath} 需要的位置插入一对：\n  <!--dashboard:status:begin -->\n  <!--dashboard:status:end-->\n再重跑 render-index（绝不猜位置覆盖人工内容）。`,
  });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), original);
});

test('A2-3 已有 INDEX 有锚时正常渲染且锚外人工内容逐字不变', (t) => {
  const { flags, indexPath } = setup(t);
  const begin = '<!--dashboard:status:begin -->';
  const end = '<!--dashboard:status:end-->';
  const prefix = '# 人工背景\r\n保留空行、中文、emoji 📝 和行末空格。  \r\n\r\n';
  const suffix = '\r\n\r\n## 人工决定\r\n\t这段由负责人维护，不自动改写。  \r\n';
  fs.writeFileSync(indexPath, prefix + begin + '\n旧状态段\n' + end + suffix, 'utf8');

  assert.equal(renderIndex(flags).ok, true);
  const bytes = fs.readFileSync(indexPath);
  const rendered = bytes.toString('utf8');
  assert.match(rendered, /自动生成.*1 任务/);
  assert.match(rendered, /\| TASK-1 \|.*示例任务/);
  assert.ok(!rendered.includes('旧状态段'));
  assert.equal(rendered.slice(0, rendered.indexOf(begin)), prefix);
  assert.equal(rendered.slice(rendered.indexOf(end) + end.length), suffix);
  assert.deepEqual(bytes.subarray(0, Buffer.byteLength(prefix)), Buffer.from(prefix));
  assert.deepEqual(bytes.subarray(bytes.length - Buffer.byteLength(suffix)), Buffer.from(suffix));
});

test('A2-4 显式 --index 路径不存在时必须报错', (t) => {
  const { flags, indexPath } = setup(t);
  const explicitPath = path.join(path.dirname(indexPath), 'missing-explicit.md');
  assert.throws(() => renderIndex({ ...flags, index: explicitPath }), {
    code: 'ENOENT', path: explicitPath,
  });
  assert.equal(fs.existsSync(explicitPath), false);

  const cli = runCli(flags, ['--index', explicitPath]);
  assert.ifError(cli.error);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /ENOENT/);
  assert.ok(cli.stderr.includes(explicitPath));
  assert.equal(cli.stdout, '');
  assert.equal(fs.existsSync(explicitPath), false);
  assert.equal(fs.existsSync(indexPath), false, '显式路径出错不能回落并创建缺省 INDEX');
});
