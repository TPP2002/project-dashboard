#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { syncRoot } = require('../core/syncCredential.cjs');
const { createSyncAgent } = require('../core/syncAgent.cjs');

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['run', 'once', 'status'].includes(args[0])) {
    process.stderr.write('用法：cloudSync run | once | status；不接受凭据参数。\n');
    return 1;
  }
  if (args[0] === 'status') {
    let status;
    try { status = JSON.parse(fs.readFileSync(path.join(syncRoot(), 'status.json'), 'utf8')); }
    catch (error) {
      process.stderr.write(error.code === 'ENOENT' ? '同步程序尚未报告状态。\n' : '无法读取同步状态。\n');
      return 1;
    }
    const names = { connected: '已连接', reconnecting: '正在重连', 'login-required': '请重新登录云端', stopped: '已停止' };
    process.stdout.write(`云同步：${names[status.agent.state] || '未知'}\n`);
    for (const [id, project] of Object.entries(status.projects)) {
      process.stdout.write(`${id}：待发送 ${project.pending} 条，未读退回 ${project.rejectedUnseen} 条，未同步提醒 ${project.untracked} 条\n`);
    }
    return 0;
  }
  const agent = createSyncAgent();
  const stop = () => { void agent.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (args[0] === 'run') await agent.run(); else await agent.syncOnce();
    return 0;
  } catch (error) {
    process.stderr.write(error.code === 'ALREADY_RUNNING' ? '同步程序已经运行。\n' : '同步未完成，请查看同步状态。\n');
    return error.code === 'ALREADY_RUNNING' ? 3 : 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (args[0] === 'once') await agent.stop();
  }
}
if (require.main === module) void main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('同步程序无法继续，请检查本机配置与文件。\n'); process.exitCode = 1;
});
module.exports = { main };
