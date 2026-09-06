'use strict';
/**
 * buildInstaller.test.cjs —— 社区安装版的打包契约(BUILD-INSTALLER-MISSES-SERVER-MODULES)。
 *
 * 【病根】packaging/build-installer.cjs 原先只 copy 了 server/server.cjs 一个文件,
 * 而 server.cjs 顶部 require 了同目录的 12 个兄弟模块(codexApi / readerApi / parallelPlan /
 * codexSessions ...)。打出来的 NSIS 安装版一启动就 MODULE_NOT_FOUND 崩溃,而打包脚本
 * 自己一路绿灯——因为它从头到尾没验过"这堆文件到底能不能起来"。
 *
 * 【本文件钉死两件事】
 *   T1 运行期代码按 core/runtimeRoot.cjs 的 RUNTIME_PATHS 整目录拷(和发布副本同一份白名单),
 *      server/ 下每个文件都要进安装目录——以后 server/ 再长新模块也不会漏;
 *   T2 打包自检真的能起服务、真的能抓到"漏文件"这类崩溃:
 *      用内嵌 node 起一次 staging 里的服务,探 /api/health 通了才算打包成功;
 *      故意删掉一个模块后,自检必须报错(否则它就是个摆设)。
 *
 * 全程只写临时目录:staging 落 tmp、registry 用 staging 自带的空 registry、
 * 随机高位端口 + DASHBOARD_NO_OPEN=1,绝不碰真实 registry、真实 6060 实例、packaging/staging。
 * web/dist 是 gitignored(CI 上不存在),故用临时假 dist 喂给 stageRoot,不依赖前端构建产物。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RUNTIME_PATHS } = require('../core/runtimeRoot.cjs');
const { stageRoot, selfCheckStagedRoot } = require('../packaging/build-installer.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const realTmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** 造一份假的 web/dist(CI 不跑前端构建,真 dist 不存在)。 */
function fakeDist(dir) {
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>看板</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), '/* stub */');
  return dist;
}

/** 把整个安装目录搭进临时目录;返回 { root, tmp, staged }。 */
function stageIntoTmp(prefix) {
  const tmp = realTmp(prefix);
  const root = path.join(tmp, 'root');
  const staged = stageRoot({
    src: DASH_ROOT,
    dest: root,
    nodeExe: process.execPath,
    distDir: fakeDist(tmp),
    log: () => {},
  });
  return { root, tmp, staged };
}

test('T1 运行期代码整目录进安装包:server/ 的每个文件都在,不再只带 server.cjs', () => {
  const { root, tmp } = stageIntoTmp('bi-stage-');
  try {
    // 白名单本身就是发布副本那一份,两处口径不许漂
    assert.ok(RUNTIME_PATHS.includes('server'), 'RUNTIME_PATHS 应含 server');

    for (const rel of RUNTIME_PATHS) {
      assert.ok(fs.existsSync(path.join(root, rel)), `安装目录缺运行期路径:${rel}`);
    }

    const srcFiles = fs.readdirSync(path.join(DASH_ROOT, 'server')).sort();
    const dstFiles = fs.readdirSync(path.join(root, 'server')).sort();
    assert.deepStrictEqual(dstFiles, srcFiles, 'server/ 必须整目录拷贝(逐个文件点名迟早漏)');
    assert.ok(srcFiles.length > 1, '前提:server/ 本来就不止一个文件');

    // 顺带钉死其余运行期件(它们缺了同样是启动即崩)
    assert.ok(fs.existsSync(path.join(root, 'web', 'dist', 'index.html')), '缺前端产物');
    assert.ok(fs.existsSync(path.join(root, 'node-runtime', 'node.exe')), '缺内嵌 node 运行时');
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
    assert.deepStrictEqual(reg.projects, {}, '分发版 registry 必须是干净的(不带打包机的私人项目)');
  } finally { clean(tmp); }
});

test('T2 打包自检:内嵌 node 起得来 + /api/health 通,才算打包成功', async () => {
  const { root, tmp } = stageIntoTmp('bi-ok-');
  try {
    const health = await selfCheckStagedRoot(root, { log: () => {} });
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.service, 'claude-dashboard');
    assert.strictEqual(health.distBuilt, true, '安装目录里的 web/dist 应被服务认出来');
    assert.ok(Number.isInteger(health.pid) && health.pid > 0);
  } finally { clean(tmp); }
});

test('T3 自检不是摆设:少一个 server 模块必须当场报错', async () => {
  const { root, tmp } = stageIntoTmp('bi-broken-');
  try {
    fs.rmSync(path.join(root, 'server', 'codexApi.cjs'));
    await assert.rejects(
      () => selfCheckStagedRoot(root, { log: () => {}, timeoutMs: 20000 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(String(err.message), /MODULE_NOT_FOUND|自检|退出|启动/);
        return true;
      },
      '删掉一个 server 模块后自检还说通过,等于没自检',
    );
  } finally { clean(tmp); }
});
