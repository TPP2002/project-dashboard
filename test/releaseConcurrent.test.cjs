'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { release } = require('../cli/release.cjs');

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function write(root, rel, body) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); }
function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-concurrent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'master']);
  git(seed, ['config', 'user.email', 't@t.t']); git(seed, ['config', 'user.name', 't']);
  write(seed, 'core/x.cjs', 'v1'); write(seed, 'cli/index.cjs', 'v1');
  write(seed, 'server/server.cjs', 'server v1'); write(seed, 'package.json', '{}');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'v1']);
  const origin = path.join(dir, 'origin.git'); git(dir, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(dir, 'work'); git(dir, ['clone', '-q', origin, work]);
  return { dir, origin, work, dest: path.join(dir, 'release') };
}
function pushFromElsewhere(t) {
  const work = path.join(t.dir, 'other'); git(t.dir, ['clone', '-q', t.origin, work]);
  git(work, ['config', 'user.email', 't@t.t']); git(work, ['config', 'user.name', 't']);
  write(work, 'server/server.cjs', 'server v2'); git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'v2']); git(work, ['push', '-q', 'origin', 'master']);
  return git(work, ['rev-parse', 'HEAD']);
}
function build({ outRoot }) { write(outRoot, 'web/dist/index.html', 'web'); return { files: 1, ms: 1 }; }
function flags(t) { return { source: t.work, dest: t.dest }; }
function stamp(t) { return fs.readFileSync(path.join(t.dest, 'RELEASE.json'), 'utf8'); }
function noResidue(t, lock = false) {
  const base = path.basename(t.dest);
  const entries = fs.readdirSync(t.dir, { withFileTypes: true });
  assert.deepEqual(entries.filter(e => e.isDirectory() && ['.new', '.old', '.boot'].some(s => e.name.startsWith(base + s))).map(e => e.name), []);
  if (!lock) assert.ok(!fs.existsSync(t.dest + '.swap.lock'));
}
function child(code) { return spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: 'ignore' }); }
function exited(p) { return new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', resolve); }); }

test('嵌套发布保留较新提交和完整副本', t => {
  const x = setup(t); let newer;
  const first = release(flags(x), { buildWeb: args => {
    newer = pushFromElsewhere(x);
    release(flags(x), { buildWeb: build });
    return build(args);
  } });
  for (const rel of ['cli/index.cjs', 'server/server.cjs', 'web/dist/index.html']) assert.ok(fs.existsSync(path.join(x.dest, rel)), rel);
  assert.equal(JSON.parse(stamp(x)).commit, newer);
  assert.equal(first.superseded, true); noResidue(x);
});

test('暂存缺文件时旧副本不变', t => {
  const x = setup(t); release(flags(x), { buildWeb: build });
  const before = stamp(x); const server = fs.readFileSync(path.join(x.dest, 'server/server.cjs'), 'utf8');
  assert.throws(() => release({ ...flags(x), force: true }, { buildWeb: args => {
    fs.unlinkSync(path.join(args.outRoot, 'server/server.cjs')); return build(args);
  } }), /暂存副本不完整[\s\S]*server\/server\.cjs/);
  assert.equal(stamp(x), before); assert.equal(fs.readFileSync(path.join(x.dest, 'server/server.cjs'), 'utf8'), server); noResidue(x);
});

test('在世持有者的锁不被抢', t => {
  const x = setup(t); release(flags(x), { buildWeb: build }); const before = stamp(x);
  const p = child('setTimeout(() => {}, 30000)'); t.after(() => p.kill());
  const lock = JSON.stringify({ pid: p.pid, startedAt: new Date().toISOString(), commit: 'x', token: 'other' });
  fs.writeFileSync(x.dest + '.swap.lock', lock);
  assert.throws(() => release({ ...flags(x), force: true, 'lock-wait-ms': 600 }, { buildWeb: build }), new RegExp(String(p.pid)));
  assert.equal(stamp(x), before); assert.equal(fs.readFileSync(x.dest + '.swap.lock', 'utf8'), lock); noResidue(x, true);
});

test('已退出进程的锁可回收', async t => {
  const x = setup(t); const p = child(''); await exited(p);
  fs.writeFileSync(x.dest + '.swap.lock', JSON.stringify({ pid: p.pid, startedAt: new Date().toISOString(), commit: 'x', token: 'old' }));
  assert.equal(release(flags(x), { buildWeb: build }).ok, true); noResidue(x);
});

test('清除已退出进程的暂存残渣', async t => {
  const x = setup(t); const p = child(''); await exited(p);
  fs.mkdirSync(x.dest + '.new-' + p.pid + '-abc123');
  assert.equal(release(flags(x), { buildWeb: build }).ok, true); noResidue(x);
});
