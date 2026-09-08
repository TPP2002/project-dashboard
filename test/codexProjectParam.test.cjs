'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const freePort = require('../scripts/free-port.cjs');

test('Codex 接口按显式项目参数读取各自代码仓', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-')));
  let child;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const mainRepo = path.join(dir, 'boards');
  const codeRepo = path.join(dir, 'code');
  const otherRepo = path.join(dir, 'other-code');
  for (const repo of [mainRepo, codeRepo, otherRepo]) fs.mkdirSync(repo);
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {
    sample: { name: '临时项目', mainRepo, codeRepo },
    other: { name: '另一项目', mainRepo, codeRepo: otherRepo },
  } }));
  child = spawn(process.execPath, [path.join(root, 'server/server.cjs')], {
    cwd: root, windowsHide: true,
    env: {
      ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry,
      DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'),
      DASHBOARD_CODEX_SESSIONS: path.join(dir, 'sessions'),
      DASHBOARD_MODULES: 'codex', DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_NO_OPEN: '1',
      DASHBOARD_PORT: String(await freePort()),
    },
  });
  const base = await new Promise((resolve, reject) => {
    let out = '', err = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`server 启动超时\n${out}\n${err}`)), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      out += data;
      const match = out.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on('data', (data) => { err += data; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`server 提前退出 ${code}\n${out}\n${err}`)));
  });

  await t.test('缺 project 返回 400', async () => {
    for (const query of ['', '?project=', '?project=sample&project=other']) {
      const response = await fetch(base + '/api/codex/jobs' + query);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, '缺 project');
    }
  });

  await t.test('不存在的项目返回 404', async () => {
    const response = await fetch(base + '/api/codex/jobs?project=missing');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, '项目 missing 的代码仓读不出');
  });

  await t.test('存在但没有 .codex 目录时返回空清单', async () => {
    assert.equal(fs.existsSync(path.join(codeRepo, '.codex')), false);
    const response = await fetch(base + '/api/codex/jobs?project=sample');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  await t.test('不同项目的同名工单分别从 codeRepo 读取', async () => {
    for (const [repo, title] of [[mainRepo, '不该读取板的家'], [codeRepo, '项目一工单'], [otherRepo, '项目二工单']]) {
      const job = path.join(repo, '.codex/jobs/shared-job');
      fs.mkdirSync(job, { recursive: true });
      fs.writeFileSync(path.join(job, 'task.json'), JSON.stringify({ title, goal: title, acceptance: [] }));
      fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify({ finishedAt: 'done', exitCode: 0 }));
    }
    for (const [project, title] of [['sample', '项目一工单'], ['other', '项目二工单']]) {
      const response = await fetch(base + '/api/codex/jobs?project=' + project);
      assert.equal(response.status, 200);
      const jobs = await response.json();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].slug, 'shared-job');
      assert.equal(jobs[0].title, title);
    }
  });
});
