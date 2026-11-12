'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const freePort = require('../scripts/free-port.cjs');
const { mapRepoToPrefix } = require('../core/costUsage.cjs');

test('demo server isolates cost, accounts and perks', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-server-'));
  const demo = path.join(root, 'demo'), normal = path.join(root, 'normal'), home = path.join(root, 'home'), repo = path.join(root, 'repo');
  for (const dir of [demo, normal, home, repo]) fs.mkdirSync(dir, { recursive: true });
  const registry = dir => path.join(dir, 'registry.json');
  for (const dir of [demo, normal]) {
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ schemaVersion: '1.0', project: { id: 'demo-a', name: 'demo-a' }, tasks: [], activity: [] }));
    fs.writeFileSync(registry(dir), JSON.stringify({ schemaVersion: '1.0', projects: { 'demo-a': { name: 'demo-a', mainRepo: repo, board: path.join(dir, 'board.json') } } }));
  }
  fs.writeFileSync(path.join(demo, 'demo-instance.json'), '{}');
  const prefix = mapRepoToPrefix(repo);
  const writeTranscript = (base, output, id) => {
    const dir = path.join(base, prefix); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sample.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: id, isSidechain: false, message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output } } }) + '\n');
  };
  writeTranscript(path.join(demo, 'claude-projects'), 1234, 'demo-session');
  writeTranscript(path.join(home, '.claude', 'projects'), 9876, 'SENTINEL-REAL-TOKENS');
  const sessionDir = path.join(home, '.codex', 'sessions', '2026', '11', '12');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'rollout-2026-11-12T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9999 } }, rate_limits: { primary: { used_percent: 59, resets_at: 0 }, secondary: null } } }) + '\n');
  const job = path.join(repo, '.codex', 'jobs', 'demo-job');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'task.json'), JSON.stringify({ title: 'SENTINEL-REAL-TOKENS', engine: 'deepseek', model: 'deepseek-flash' }));
  fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify({ finishedAt: new Date().toISOString(), exitCode: 0 }));
  fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ dispatchedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(job, 'exec.jsonl'), JSON.stringify({ type: 'result', model: 'deepseek-flash', usage: { input_tokens: 2000, output_tokens: 3000 } }) + '\n');
  fs.writeFileSync(path.join(repo, '.codex', 'workbuddy-ledger.json'), JSON.stringify({ schemaVersion: 1, requests: { 'sample': { at: new Date().toISOString(), repo, model: 'SENTINEL-REAL-TOKENS', credits: 20 } } }));
  const log = path.join(root, 'probe.log'), preload = path.join(root, 'probe.cjs');
  const roots = [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions'), path.join(repo, '.codex')];
  fs.writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path');
const log = ${JSON.stringify(log)}, roots = ${JSON.stringify(roots)};
const record = value => fs.appendFileSync(log, String(value) + '\\n');
for (const name of ['readFileSync','createReadStream','readdirSync','statSync','openSync']) {
  const original = fs[name]; fs[name] = function(value, ...rest) {
    if (typeof value === 'string' && roots.some(root => value === root || value.startsWith(root + path.sep))) record('file ' + value);
    return original.call(this, value, ...rest);
  };
}
for (const mod of ['node:http','node:https']) { const obj = require(mod), original = obj.request; obj.request = function(...args) {
  const arg = args[0], host = typeof arg === 'string' || arg instanceof URL ? new URL(arg).hostname : arg?.hostname || arg?.host;
  if (host && !['localhost','127.0.0.1','::1'].includes(host)) record('request ' + host);
  return original.apply(this,args);
}; }
const net = require('node:net'), connect = net.connect; net.connect = function(...args) {
  const host = typeof args[0] === 'object' ? args[0].host : args[1];
  if (typeof host === 'string' && !['localhost','127.0.0.1','::1'].includes(host)) record('connect ' + host);
  return connect.apply(this,args);
};
const oldFetch = globalThis.fetch; globalThis.fetch = function(input,...args) { const host = new URL(typeof input === 'string' ? input : input.url).hostname; if (!['localhost','127.0.0.1','::1'].includes(host)) record('fetch ' + host); return oldFetch.call(this,input,...args); };
const cp = require('node:child_process'); for (const name of ['spawn','execFile','exec','fork']) { const original = cp[name]; cp[name] = function(...args) { record('child ' + name + ' ' + String(args[0]) + ' ' + new Error().stack.replace(/\\n/g, ' | ')); return original.apply(this,args); }; }
for (const name of ['spawnSync','execFileSync','execSync']) { const original = cp[name]; cp[name] = function(command, ...args) { record('child ' + name); if (name === 'spawnSync' && command === 'reg') return { status: 1, stdout: '' }; return original.call(this, command, ...args); }; }
`);
  const control = path.join(root, 'control.cjs');
  fs.writeFileSync(control, "require('node:https').request('https://example.invalid').on('error',()=>{}).end();");
  spawnSync(process.execPath, ['--require', preload, control], { timeout: 5000, windowsHide: true });
  assert.match(fs.readFileSync(log, 'utf8'), /request example\.invalid/);
  fs.writeFileSync(log, '');
  async function launch(dir, key) {
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry(dir), DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_MODULES: 'all', DASHBOARD_DISPATCHER_REPO: root };
    delete env.DASHBOARD_CODEX_SESSIONS; delete env.DEEPSEEK_API_KEY;
    delete env.DASHBOARD_CI_REPOSITORIES; delete env.DASHBOARD_EVENT_WEBHOOK;
    if (key) env.DEEPSEEK_API_KEY = 'synthetic-key';
    const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../server/server.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error(output)), 10000);
      // The address is printed before the initial CI repository probe completes.
      const onData = chunk => { output += chunk; if (output.includes('本地地址：') && output.includes('[sched-ci] 项目 demo-a 的远端')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData); child.once('error', reject);
    });
    return `http://127.0.0.1:${port}`;
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = await launch(demo, true);
  fs.writeFileSync(log, '');
  for (const endpoint of ['/api/cost?project=demo-a', '/api/cost?project=all', '/api/cost/session-detail?project=demo-a', '/api/cost/job-detail?project=demo-a', '/api/codex/quota?project=demo-a', '/api/codex/report?project=demo-a', '/api/codex/sessions?project=demo-a', '/api/resources']) {
    const response = await fetch(base + endpoint); const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(!body.includes('SENTINEL-REAL-TOKENS') && !body.includes(home) && !body.includes(repo));
    assert.ok(!body.includes(JSON.stringify(home).slice(1, -1)) && !body.includes(JSON.stringify(repo).slice(1, -1)));
    if (endpoint === '/api/cost?project=demo-a') { const data = JSON.parse(body); assert.equal(data.usage.totals.output, 1234); assert.equal(data.deepseekBalance.available, false); assert.equal(data.quota.usedPercent, null); }
  }
  assert.equal((await fetch(base + '/api/resources/action', { method: 'POST' })).status, 403);
  assert.equal((await (await fetch(base + '/api/health')).json()).demo, true);
  assert.deepEqual(await (await fetch(base + '/api/perks/available')).json(), { ok: true, available: false });
  for (const [route, method] of [['/api/perks', 'GET'], ['/api/perks/action', 'POST']]) {
    const response = await fetch(base + route, { method }); assert.equal(response.status, 403); assert.equal((await response.json()).error, '演示实例不提供每日福利');
  }
  assert.equal(fs.readFileSync(log, 'utf8'), '');
  const normalBase = await launch(normal, false);
  const normalPerks = [];
  for (const [route, method] of [['/api/perks/available', 'GET'], ['/api/perks', 'GET'], ['/api/perks/action', 'POST']]) normalPerks.push((await fetch(normalBase + route, { method })).status);
  for (const [i, [route, method]] of [['/api/perks/available', 'GET'], ['/api/perks', 'GET'], ['/api/perks/action', 'POST']].entries()) assert.equal((await fetch(normalBase + route, { method })).status, normalPerks[i]);
  fs.writeFileSync(log, '');
  const normalCost = await (await fetch(normalBase + '/api/cost?project=demo-a')).json();
  assert.equal(normalCost.usage.totals.output, 9876);
  assert.match(fs.readFileSync(log, 'utf8'), /file /);
});
