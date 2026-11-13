'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');

function buildPlan({ targets, agentDir, agentSource, unitSource }) {
  const agent = Buffer.from(Buffer.from(agentSource).toString('utf8').replace(/\r\n/g, '\n'));
  const unit = Buffer.from(Buffer.from(unitSource).toString('utf8').replace(/\r\n/g, '\n').replaceAll('/opt/hostmon/hostmon.py', `${agentDir}/hostmon.py`));
  return [
    { title: '连接服务器', remote: 'echo ok', stdin: undefined, targets },
    { title: '检查 Python', remote: "python3 -c 'import sys; print(sys.version_info[:2] >= (3, 8))'", stdin: undefined },
    { title: '上传采集程序', remote: `mkdir -p ${agentDir} && cat > ${agentDir}/hostmon.py.tmp && mv ${agentDir}/hostmon.py.tmp ${agentDir}/hostmon.py && chmod 755 ${agentDir}/hostmon.py`, stdin: agent },
    { title: '上传服务文件', remote: 'cat > /etc/systemd/system/hostmon.service.tmp && mv /etc/systemd/system/hostmon.service.tmp /etc/systemd/system/hostmon.service', stdin: unit },
    { title: '启动服务', remote: "systemctl daemon-reload && systemctl enable hostmon && systemctl restart hostmon && (pkill -f '[h]ostmon.py stream' || true)", stdin: undefined },
    { title: '等待采集', remote: 'test -f /run/hostmon/latest.json', stdin: undefined },
    { title: '检查采集', remote: `python3 ${agentDir}/hostmon.py once`, stdin: undefined },
  ];
}

async function runInstall(argv, injected = {}) {
  const spawn = injected.spawn || childProcess.spawn;
  const readFile = injected.readFile || fs.readFile;
  const log = injected.log || console.log;
  const sleep = injected.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const targets = []; let agentDir = '/opt/hostmon', dry = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i+1 < argv.length) targets.push(argv[++i]);
    else if (argv[i] === '--agent-dir' && i+1 < argv.length) agentDir = argv[++i];
    else if (argv[i] === '--dry-run') dry = true;
    else { log('参数无效'); return 2; }
  }
  if (!targets.length || targets.some(t => !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(t)) || !/^\/[A-Za-z0-9._/-]+$/.test(agentDir)) { log('参数无效'); return 2; }
  let plan;
  try { plan = buildPlan({ targets, agentDir, agentSource: await readFile(path.join(__dirname, '../remote-agent/hostmon.py')), unitSource: await readFile(path.join(__dirname, '../remote-agent/hostmon.service')) }); }
  catch (err) { log(`读取安装文件失败:${err.message}`); return 1; }
  if (dry) {
    for (const step of plan) log(`${step.title} 目标:${targets.join(',')} 命令:${step.remote} 标准输入:${step.stdin ? step.stdin.length : 0} 字节`);
    return 0;
  }
  function exec(target, step) {
    return new Promise(resolve => {
      let out = '', err = '', done = false;
      const finish = code => { if (!done) { done = true; resolve({ code, out, err }); } };
      let child;
      try { child = spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=15',target,step.remote], { windowsHide:true, shell:false }); }
      catch (e) { err = e.message; finish(1); return; }
      child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
      child.on('error', e => { err += e.message; finish(1); }); child.on('close', finish);
      child.stdin.on && child.stdin.on('error', () => {});
      child.stdin.end(step.stdin);
    });
  }
  const last = s => s.trim().split(/\r?\n/).pop() || '';
  let target;
  for (const t of targets) { const r = await exec(t, plan[0]); if (r.code === 0) { target = t; break; } log(`${t}: ${last(r.err)}`); }
  if (!target) { log('第 1 步 连接服务器 失败:全部目标无法连接'); return 1; }
  for (let i = 1; i < plan.length; i++) {
    let r;
    if (i === 5) {
      for (let attempt = 0; attempt < 15; attempt++) { r = await exec(target, plan[i]); if (r.code === 0) break; if (attempt < 14) await sleep(1000); }
    } else r = await exec(target, plan[i]);
    if (r.code !== 0) { log(`第 ${i+1} 步 ${plan[i].title} 失败:${last(r.err)}`); return 1; }
    if (i === 1 && r.out.trim() !== 'True') { log('第 2 步 检查 Python 失败:服务器的 python3 低于 3.8'); return 1; }
    if (i === 6) {
      try {
        const data = JSON.parse(r.out); const host = data.hello.host;
        log(`主机名:${host.hostname}，逻辑处理器数:${host.logicalCores}，内存总量:${(host.memTotalMb/1024).toFixed(1)} GB，CPU 利用率:${data.point.cpu}%，在跑任务数:${data.procs.tasks.filter(t => t.kind === 'job').length}`);
      } catch (e) { log(`第 7 步 检查采集 失败:${e.message}`); return 1; }
    }
  }
  log('采集程序已装好,版本 1'); return 0;
}
module.exports = { buildPlan, runInstall };
if (require.main === module) runInstall(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(err.message); process.exitCode = 1; });
