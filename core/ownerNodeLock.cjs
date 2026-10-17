'use strict';
// Linux owns a permanent inode via flock; Windows retains immutable generations.
// No contender ever unlinks or renames another writer's lock.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');
function observe(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {state:'unknown'};
  if (process.platform === 'linux') {
    // Local proc is only evidence for conservative legacy migration, never the
    // Linux exclusion mechanism. Do not scan a host-mounted process namespace.
    const root='/proc';
    try {
      const boot=fs.readFileSync(path.join(root,'sys/kernel/random/boot_id'),'utf8').trim();
      const scope=String(fs.statSync(path.join(root,'1/ns/pid')).ino);
      if(!/^[a-f0-9-]{36}$/.test(boot)||!/^\d+$/.test(scope))return {state:'unknown'};
      let stat;
      try { stat=fs.readFileSync(path.join(root,String(pid),'stat'),'utf8'); }
      catch(e) { if(e.code==='ENOENT')return {state:'absent',boot,scope};throw e; }
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(!/^\d+$/.test(fields[19]||''))return {state:'unknown'};
      return {state:'present',identity:{platform:'linux',pid,boot,scope,birth:fields[19]}};
    } catch {return {state:'unknown'};}
  }
  if(process.platform==='win32') {
    const script=`$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;birth=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(r.error||r.status!==0)return {state:'unknown'};
    try {const p=JSON.parse(r.stdout);if(p===null)return {state:'absent'};if(p.pid!==pid||typeof p.birth!=='string'||!p.birth)return {state:'unknown'};return {state:'present',identity:{platform:'win32',...p}};}catch{return {state:'unknown'};}
  }
  return {state:'unknown'};
}
function ownIdentity() {
  const observation=observe(process.pid);
  if(observation.state!=='present')throw new Error('Writer process identity unavailable');
  return observation.identity;
}
function absent(expected) {
  if(!expected||expected.platform!==process.platform||typeof expected.birth!=='string'||!expected.birth)return false;
  if(process.platform==='linux'&&(!/^[a-f0-9-]{36}$/.test(expected.boot||'')||!/^\d+$/.test(expected.scope||'')||!/^\d+$/.test(expected.birth)))return false;
  const current=observe(expected.pid);
  if(current.state==='unknown')return false;
  if(process.platform==='linux') {
    const now=current.identity||current;
    if(now.boot!==expected.boot)return true;
    // A different PID namespace cannot establish whether the old process lives.
    if(now.scope!==expected.scope)return false;
  }
  return current.state==='absent'||current.identity.birth!==expected.birth;
}
function publish(file,value) {
  const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temp,file);}finally{fs.unlinkSync(temp);}
}
function exclusive(root) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(process.platform==='linux')return linuxExclusive(path.resolve(root));
  const generations=path.join(root,'writer-generations');fs.mkdirSync(generations,{mode:0o700,recursive:true});
  const own={token:randomUUID(),identity:ownIdentity()},initial=path.join(root,'writer.lock');
  let file=initial;
  for(let attempts=0;attempts<100000;attempts++) {
    try {publish(file,own);let released=false;return ()=>{if(released)return;publish(path.join(generations,own.token+'.released'),own);released=true;};}
    catch(e){if(e.code!=='EEXIST')throw e;}
    const previous=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!/^[a-f0-9-]{36}$/.test(previous.token||''))throw new Error('Legacy writer lock requires identity reconciliation');
    if(!fs.existsSync(path.join(generations,previous.token+'.released'))&&!absent(previous.identity))throw new Error('Writer active or identity unconfirmed');
    file=path.join(generations,previous.token+'.next');
  }
  throw new Error('Writer generation limit exceeded');
}

function sameInode(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function protectedDirectory(root){
  const stat=fs.lstatSync(root,{bigint:true});
  if(!stat.isDirectory()||fs.realpathSync(root)!==root||stat.uid!==BigInt(process.getuid())||(stat.mode&0o022n)!==0n)throw new Error('Writer directory is not protected');
  return stat;
}
function checkFile(file,fd){
  const opened=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
  if(!opened.isFile()||!named.isFile()||!sameInode(opened,named)||opened.nlink!==1n||opened.uid!==BigInt(process.getuid())||(opened.mode&0o022n)!==0n)throw new Error('Writer lock is not a fixed protected regular file');
}
function readLegacy(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    checkFile(file,fd);
    if(fs.fstatSync(fd).size>4096)throw new Error('Legacy writer lock requires reconciliation');
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));checkFile(file,fd);return value;
  }finally{fs.closeSync(fd);}
}
function sealLegacy(root){
  const generations=path.join(root,'writer-generations');
  fs.mkdirSync(generations,{recursive:true,mode:0o700});protectedDirectory(generations);
  let file=path.join(root,'writer.lock');
  for(let attempts=0;attempts<100000;attempts++){
    let previous;
    try{previous=readLegacy(file);}catch(e){
      if(e.code!=='ENOENT')throw e;
      // The legacy hard-link CAS arbitrates against an old executable racing
      // migration. With no identity/release, old executables fail closed here.
      try{publish(file,{token:randomUUID(),protocol:'linux-flock-v1'});return;}
      catch(error){if(error.code==='EEXIST')continue;throw error;}
    }
    if(!/^[a-f0-9-]{36}$/.test(previous.token||''))throw new Error('Legacy writer lock requires identity reconciliation');
    if(previous.protocol==='linux-flock-v1')return;
    let released=false;
    try{
      const receipt=readLegacy(path.join(generations,previous.token+'.released'));
      released=receipt.token===previous.token&&JSON.stringify(receipt.identity)===JSON.stringify(previous.identity);
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if(!released&&!absent(previous.identity))throw new Error('Legacy writer active or identity unconfirmed; reconciliation required');
    file=path.join(generations,previous.token+'.next');
  }
  throw new Error('Writer generation limit exceeded');
}
function linuxExclusive(root){
  const directory=protectedDirectory(root),file=path.join(root,'writer.flock');
  // This inode is permanent: neither normal release nor crash recovery removes
  // it. FD 3 in flock shares the parent's open file description.
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
  try{
    checkFile(file,fd);
    const result=spawnSync('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','pipe','pipe',fd],timeout:5000,maxBuffer:65536});
    if(result.error||result.signal)throw new Error('Writer flock unavailable; refusing ownership');
    if(result.status===75)throw new Error('Writer active (flock conflict)');
    if(result.status!==0)throw new Error('Writer flock failed; refusing ownership');
    checkFile(file,fd);
    if(!sameInode(directory,protectedDirectory(root)))throw new Error('Writer directory replaced');
    sealLegacy(root);
    checkFile(file,fd);
    if(!sameInode(directory,protectedDirectory(root)))throw new Error('Writer directory replaced');
    let released=false;
    return ()=>{if(released)return;fs.closeSync(fd);released=true;};
  }catch(e){fs.closeSync(fd);throw e;}
}
module.exports={exclusive,observe,absent,ownIdentity};
