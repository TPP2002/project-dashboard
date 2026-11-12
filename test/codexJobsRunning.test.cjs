'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const freePort = require('../scripts/free-port.cjs');

test('running filter and cost endpoints use persisted summaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'running-jobs-'));
  const repo = path.join(root, 'demo-a'), registry = path.join(root, 'registry.json');
  fs.mkdirSync(repo);
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: { 'demo-a': { name: 'demo-a', mainRepo: repo } } }));
  for (const [slug, state] of [['running', { finishedAt: null }], ['done', { finishedAt: new Date().toISOString() }]]) {
    const job = path.join(repo, '.codex', 'jobs', slug);
    fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, 'task.json'), JSON.stringify({ engine: 'codex', title: slug }));
    fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ dispatchedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(job, 'exec.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'demo' } }));
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.cjs')], { windowsHide: true,
    env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_REGISTRY: registry, DASHBOARD_HOME: root,
      DASHBOARD_MODULES: 'codex,cost', DASHBOARD_CODEX_SESSIONS: path.join(root, 'sessions'), DASHBOARD_PORT: String(port), DEEPSEEK_API_KEY: '' } });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
    child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/127\.0\.0\.1:(\d+)\//); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exit ${code}`)));
  });
  async function get(url) { const res = await fetch(base + url); assert.equal(res.status, 200); return res.json(); }
  const all = await get('/api/codex/jobs?project=demo-a');
  const running = await get('/api/codex/jobs?project=demo-a&running=1');
  assert.equal(all.length, 2);
  assert.deepEqual(running, all.filter((job) => job.running === true));
  for (const endpoint of ['/api/cost?project=demo-a', '/api/cost/job-detail?project=demo-a']) {
    assert.deepEqual(await get(endpoint), await get(endpoint));
  }
  const memo = path.join(root, 'jobFileMemo.json');
  for (let i = 0; i < 100 && !fs.existsSync(memo); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(memo));
});
