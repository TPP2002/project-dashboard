'use strict';
const { spawnSync } = require('node:child_process');
function identity(pid,{platform=process.platform,run=spawnSync}={}) {
  if(platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0)return null;
  const script=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -eq $p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;birth=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`;
  const r=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768});
  if(r.error||r.status!==0)return null;
  try{const value=JSON.parse(r.stdout);return value?.pid===pid&&typeof value.birth==='string'&&typeof value.command==='string'?value:null;}catch{return null;}
}
function matches(expected,actual) {return !!expected&&!!actual&&expected.pid===actual.pid&&expected.birth===actual.birth&&expected.command===actual.command;}
module.exports={identity,matches};
