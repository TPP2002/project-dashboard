'use strict';
// Fixtures only: no tests are registered when this module is imported.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {requestId} = require('../core/boardCommandRetention.cjs');
const {spawnSync,spawn} = require('node:child_process');
const {emptyBoard} = require('../core/boardSchema.cjs');
const {VERSION} = require('../core/boardCommand.cjs');
const ROOT = path.resolve(__dirname,'..');
const CLI = path.join(ROOT,'cli','index.cjs');
const GATEWAY = path.join(ROOT,'cli','remoteGateway.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'remote-board-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const local = path.join(root,'local'), cloud = path.join(root,'cloud'), repo = path.join(root,'repo');
  for (const dir of [local,cloud,repo]) fs.mkdirSync(dir);
  const write = (file,value) => fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
  const board = path.join(cloud,'board.json'), old = path.join(local,'frozen','old.json');
  fs.mkdirSync(path.dirname(old));
  write(board,emptyBoard({id:'p',name:'测试',mainRepo:cloud}));
  write(old,emptyBoard({id:'p',name:'旧板',mainRepo:repo}));
  write(path.join(cloud,'registry.json'),{projects:{p:{mainRepo:cloud,board}}});
  const registry = path.join(local,'registry.json');
  write(registry,{projects:{p:{mainRepo:repo,board:old}}});
  const authorityFile = path.join(cloud,'authority.json');
  const authority = {version:1,authorityId:'test-authority',authorityEpoch:1,ownerId:'owner-device',home:cloud,registryPath:path.join(cloud,'registry.json'),projects:{p:{repoBindings:{'repo-p':{ownerIds:['owner-device']}}}}};
  write(authorityFile,authority);
  const remoteFile = path.join(local,'remote.json');
  const remote = {version:1,projects:{p:{authorityId:authority.authorityId,authorityEpoch:1,repoBindingId:'repo-p',transport:{type:'stdio',executable:process.execPath,args:[GATEWAY,'--authority',authorityFile]}}}};
  write(remoteFile,remote);
  const env = {...process.env,DASHBOARD_HOME:local,DASHBOARD_REMOTE_CONFIG:remoteFile,DASHBOARD_REMOTE_TEST_TRANSPORT:'1',DASHBOARD_HOOK_CLI_ROOT:ROOT,DASHBOARD_GLOBAL_SETTINGS:path.join(local,'settings.json')};
  // No production configuration is inferred, even on developer hosts with these variables set.
  delete env.CLAUDE_CODE_SESSION_ID;
  env.DASHBOARD_SKIP_SERVICE_PROBE='1';
  env.DASHBOARD_RELEASE_HOME=path.join(local,'release');
  const request = (command,args={},id=requestId()) => ({version:VERSION,authorityId:authority.authorityId,authorityEpoch:1,requestId:id,projectId:'p',command,args:{_:[],...args}});
  const gateway = r => spawnSync(process.execPath,[GATEWAY,'--authority',authorityFile],{input:JSON.stringify(r),encoding:'utf8',env,cwd:repo});
  const cli = (args,opts={}) => spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',env,cwd:repo,...opts});
  const concurrent = (args,opts={}) => new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[CLI,...args],{env,cwd:repo,...opts}); let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject); child.on('close',status=>resolve({status,stdout,stderr}));
  });
  return {root,local,cloud,repo,board,old,registry,authority,authorityFile,remote,remoteFile,env,write,request,gateway,cli,concurrent,read:()=>JSON.parse(fs.readFileSync(board,'utf8'))};
}
function must(result) {
  require('node:assert/strict').equal(result.status,0,result.stderr + result.stdout);
  return result;
}
const addArgs = id => ['add',id,'--project','p','--title','远程测试任务','--plain-title','多人共同记录同一份任务进展','--model','test'];
module.exports = {fixture,must,addArgs,ROOT,CLI,GATEWAY};
