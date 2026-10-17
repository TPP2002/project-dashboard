#!/usr/bin/env node
'use strict';
// SSH forced entry: OS authenticates owner. This is not an HTTP endpoint or shell service.
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../core/boardCommand.cjs');
function loadAuthority(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('authority 配置必须为受保护私有文件');
  const a = JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if (a.version !== 1 || typeof a.ownerId !== 'string' || !a.ownerId || typeof a.authorityId !== 'string' || !Number.isSafeInteger(a.authorityEpoch) || a.authorityEpoch < 1 || !a.projects || typeof a.projects !== 'object' || Array.isArray(a.projects) || typeof a.registryPath !== 'string' || typeof a.home !== 'string' || !a.home) throw new Error('authority 配置无效');
  return a;
}
function readInput() {
  const chunks = []; const buf = Buffer.alloc(8192); let total = 0;
  for (;;) { const n = fs.readSync(0,buf,0,buf.length,null); if (!n) break; total += n; if (total > protocol.MAX_BYTES) throw new Error('请求超过上限'); chunks.push(Buffer.from(buf.subarray(0,n))); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,''));
}
function main() {
  let r, a;
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--init' && args.length === 2) {
      require('./remoteConfig.cjs').initialize(args[1],readInput());
      return;
    }
    if (args.length !== 2 || !['--authority','--init-project'].includes(args[0])) throw new Error('固定入口需 --authority 或 --init-project <受保护配置>');
    a = loadAuthority(args[1]);
    // Explicit server data root prevents accidental use of a developer's remote.json.
    process.env.DASHBOARD_HOME = path.resolve(a.home);
    delete process.env.DASHBOARD_REMOTE_CONFIG;
    r = readInput();
    const result = args[0] === '--init-project' ? require('./remoteProject.cjs').initOnAuthority(r,a) : require('./commandService.cjs').run(r,{authority:a,subject:{id:a.ownerId,role:'owner'},registryPath:path.resolve(a.registryPath)});
    const output = JSON.stringify({version:protocol.VERSION,authorityId:a.authorityId,authorityEpoch:a.authorityEpoch,requestId:r.requestId,ok:true,result}) + '\n';
    if (Buffer.byteLength(output) > protocol.MAX_RESPONSE_BYTES) throw new Error('远程响应超过64MiB上限');
    process.stdout.write(output);
  } catch (e) {
    process.stdout.write(JSON.stringify({version:protocol.VERSION,authorityId:a && a.authorityId,authorityEpoch:a && a.authorityEpoch,requestId:r && r.requestId,ok:false,error:e.message}) + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { loadAuthority, main };
