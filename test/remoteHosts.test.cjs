'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRemoteHostsMonitor, parseRemoteHostsConfig } = require('../core/remoteHosts.cjs');

function fixture(hosts = [{ name: 'demo-1', label: 'Demo', targets: ['demo-1'] }]) {
  let time = 100000, id = 0, version = 1, content = hosts === null ? null : JSON.stringify({ hosts });
  const timers = new Map(), children = [];
  const schedule = (fn, ms, repeat) => { const key = ++id; timers.set(key, { fn, at: time + ms, ms, repeat }); return key; };
  const tick = ms => { const end = time + ms; for (;;) { let found; for (const [key, timer] of timers) if (timer.at <= end && (!found || timer.at < found.timer.at)) found = { key, timer }; if (!found) break; time = found.timer.at; if (found.timer.repeat) found.timer.at += found.timer.ms; else timers.delete(found.key); found.timer.fn(); } time = end; };
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
    child.kill = () => { child.kills++; child.emit('exit', null); }; child.command = command; child.args = args; child.options = options; children.push(child); return child;
  };
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
  const monitor = createRemoteHostsMonitor({ configFile: 'fixture', spawn, now: () => time,
    setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: key => timers.delete(key),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: key => timers.delete(key),
    readFile: () => content === null ? missing() : content, statFile: () => content === null ? missing() : ({ mtimeMs: version }), log: () => {} });
  const update = value => { content = value === null ? null : typeof value === 'string' ? value : JSON.stringify({ hosts: value }); version++; };
  return { monitor, children, tick, update };
}
const hello = { type: 'hello', protocol: 1, agentVersion: 1, daemon: true, host: { logicalCores: 32, memTotalMb: 1000 } };
const point = t => ({ t, cpu: 38.4, busyCores: 12.3, mem: { usedMb: 100, availMb: 900 } });
const send = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');

test('配置校验和缺省值', () => {
  const f = fixture(null); f.monitor.start(); assert.deepEqual(f.monitor.list(100000).hosts, []); assert.equal(f.monitor.list(100000).configError, null); assert.equal(f.children.length, 0); f.monitor.stop();
  for (const value of ['{', JSON.stringify({ hosts: [{ name: 'demo-1', label: 'd', targets: ['-oProxyCommand=x'] }] }), JSON.stringify({ hosts: [{ name: 'demo-1', label: 'a', targets: ['demo-1'] }, { name: 'demo-1', label: 'b', targets: ['demo-2'] }] })]) {
    assert.ok(parseRemoteHostsConfig(value).error); const x = fixture(null); x.update(value); x.monitor.start(); assert.ok(x.monitor.list(100000).configError); assert.equal(x.children.length, 0); x.monitor.stop();
  }
  const config = parseRemoteHostsConfig(JSON.stringify({ hosts: [{ name: 'demo-1', label: 'd', targets: ['demo-1'] }] }));
  assert.equal(config.hosts[0].python, 'python3'); assert.equal(config.hosts[0].agentPath, '/opt/hostmon/hostmon.py');
});

test('连接、分行、历史、读数与挂载点', () => {
  const f = fixture(); f.monitor.start(); const c = f.children[0];
  assert.equal(c.command, 'ssh'); assert.deepEqual(c.args, ['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','demo-1','python3','/opt/hostmon/hostmon.py','stream','--backfill-minutes','1440']); assert.equal(c.options.windowsHide, true); assert.notEqual(c.options.shell, true);
  const h = JSON.stringify(hello); c.stdout.write(h.slice(0, 8)); c.stdout.write(h.slice(8) + '\n');
  c.stdout.write('bad\n' + JSON.stringify({ type: 'history', resolution: '1s', points: Array.from({ length: 700 }, (_, i) => point(i)) }) + '\n' + JSON.stringify({ type: 'history', resolution: '1m', points: [point(0)] }) + '\n');
  send(c, { type: 'sample', point: point(700) }); send(c, { type: 'sample', point: point(699) });
  send(c, { type: 'minute', point: { ...point(0), cpu: 22 } });
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: String(i), kind: 'job' })).concat({ id: 'system', kind: 'system' });
  const fs = [{ mount: '/', totalMb: 100, usedMb: 40, availMb: 60 }, { mount: '/boot/efi', totalMb: 200, usedMb: 20, availMb: 180 }];
  send(c, { type: 'procs', at: '2026-01-01T00:00:00Z', totals: { processes: 1 }, tasks, processes: [{ pid: 1 }], omitted: 2, fs });
  const s = f.monitor.list(100000).hosts[0]; assert.equal(s.status, 'online'); assert.equal(s.capacity.freeCores, 19.7); assert.equal(s.spark.cpu.length, 60); assert.equal(s.taskCount, 10); assert.equal(s.tasks.length, 9); assert.equal(s.tasks[8].kind, 'system'); assert.deepEqual(s.disk, fs[0]);
  assert.deepEqual(f.monitor.processes('demo-1', 100000).fs, fs); assert.deepEqual(f.monitor.processes('demo-1', 100000).tasks, tasks);
  assert.equal(f.monitor.perf('demo-1', '10m', 100000).points.length, 600); assert.equal(f.monitor.perf('demo-1', '10m', 100000).points.at(-1).t, 700); assert.equal(f.monitor.perf('demo-1', '60s', 100000).points.length, 60); assert.equal(f.monitor.perf('demo-1', '60s', 100000).resolution, '1s'); assert.equal(f.monitor.perf('demo-1', '24h', 100000).resolution, '1m'); assert.equal(f.monitor.perf('demo-1', '24h', 100000).points[0].cpu, 22); assert.equal(f.monitor.perf('absent', '60s', 100000), null); assert.throws(() => f.monitor.perf('demo-1', 'bad', 100000));
  send(c, { type: 'procs', tasks: [], processes: [], totals: null, omitted: 0 }); assert.equal(f.monitor.list(100000).hosts[0].disk, null); assert.deepEqual(f.monitor.processes('demo-1', 100000).fs, []); f.monitor.stop();
});

test('看门狗、协议拒绝、退避和停止', () => {
  const f = fixture([{ name: 'demo-1', label: 'Demo', targets: ['demo-1', 'demo-2'] }]); f.monitor.start();
  f.children[0].emit('exit', 1); f.tick(2999); assert.equal(f.children.length, 1); f.tick(1); assert.equal(f.children[1].args[9], 'demo-2');
  f.children[1].emit('exit', 1); f.tick(5000); f.children[2].emit('exit', 1); f.tick(10000); f.children[3].emit('exit', 1); f.tick(30000); f.children[4].emit('exit', 1); f.tick(60000); assert.equal(f.children.length, 6);
  f.children[5].emit('exit', 1); f.tick(59999); assert.equal(f.children.length, 6); f.tick(1); assert.equal(f.children.length, 7);
  send(f.children[6], { ...hello, protocol: 2 }); assert.match(f.monitor.list(100000).hosts[0].error, /协议版本/); const count = f.children.length; f.tick(59999); assert.equal(f.children.length, count); f.tick(1); assert.equal(f.children.length, count + 1); f.monitor.stop(); const stopped = f.children.length; f.tick(600000); assert.equal(f.children.length, stopped);
  const a = fixture(); a.monitor.start(); send(a.children[0], hello); a.tick(20000); assert.match(a.monitor.list(120000).hosts[0].error, /15 秒/); a.monitor.stop();
  const b = fixture(); b.monitor.start(); b.tick(30000); assert.match(b.monitor.list(130000).hosts[0].error, /30 秒没连上/); b.monitor.stop();
  const c = fixture(); c.monitor.start(); const err = new Error('missing'); err.code = 'ENOENT'; c.children[0].emit('error', err); assert.equal(c.monitor.list(100000).hosts[0].error, '本机找不到 ssh 命令'); c.tick(3000); assert.equal(c.children.length, 2); c.monitor.stop();
});

test('稳定在线后保留目标，进程表缺省为空', () => {
  const f = fixture([{ name: 'demo-1', label: 'Demo', targets: ['demo-1', 'demo-2'] }]); f.monitor.start();
  const child = f.children[0]; assert.deepEqual(f.monitor.processes('demo-1', 100000).tasks, []); assert.deepEqual(f.monitor.processes('demo-1', 100000).processes, []);
  send(child, hello); for (let i = 0; i < 6; i++) { f.tick(10000); send(child, { type: 'notice', code: 'daemon-back', message: '' }); }
  child.emit('exit', 1); f.tick(2999); assert.equal(f.children.length, 1); f.tick(1); assert.equal(f.children[1].args[9], 'demo-1'); f.monitor.stop();
});

test('超长行丢弃后继续读取下一行', () => {
  const f = fixture(); f.monitor.start(); const child = f.children[0];
  child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1) + '\n'); send(child, hello);
  assert.equal(f.monitor.list(100000).hosts[0].status, 'online'); f.monitor.stop();
});

test('配置变化只重启有变化的主机', () => {
  const one = { name: 'demo-1', label: 'Demo', targets: ['demo-1'] }, two = { name: 'demo-2', label: 'Demo 2', targets: ['demo-2'] };
  const f = fixture([one]); f.monitor.start(); send(f.children[0], hello); f.update([one, two]);
  for (let i = 0; i < 3; i++) { f.tick(10000); send(f.children[0], { type: 'notice', code: 'daemon-back', message: '' }); }
  assert.equal(f.children.length, 2); assert.equal(f.children[0].kills, 0); send(f.children[1], hello);
  f.update([two]); for (let i = 0; i < 3; i++) { f.tick(10000); send(f.children[0], { type: 'notice', code: 'daemon-back', message: '' }); send(f.children[1], { type: 'notice', code: 'daemon-back', message: '' }); }
  assert.equal(f.children[0].kills, 1); assert.equal(f.children.length, 2); f.monitor.stop();
});
