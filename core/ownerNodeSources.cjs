'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./ownerNodeContract.cjs');
const { atomic } = require('./ownerNodeStore.cjs');
const MANIFEST = 'docs/design/审计回流/reader.json';
const INDEX = 'docs/design/audio/试听台/audition.json';
const EXPORTS = { reader:'docs/design/审计回流/批注', audition:'docs/design/audio/试听台/批注' };
function inside(root, rel, writing = false) {
  if (!C.relative(rel)) C.fail('Invalid relative source',403);
  if(fs.lstatSync(root).isSymbolicLink())C.fail('Linked project root denied',403);
  const realRoot = fs.realpathSync.native(root);
  let current=realRoot;
  for (const part of rel.split('/')) {
    current=path.join(current,part);
    try {
      const st=fs.lstatSync(current);
      // Refuse all links, not just ones which currently resolve outside the root.
      if (st.isSymbolicLink()) C.fail('Linked source denied',403);
      const real=fs.realpathSync.native(current), r=path.relative(realRoot,real);
      if (r==='..' || r.startsWith('..'+path.sep) || path.isAbsolute(r)) C.fail('Source escapes root',403);
    } catch(error) { if (!(writing && error.code==='ENOENT')) throw error; }
  }
  return current;
}
function bytes(root,rel) {
  const file=inside(root,rel), fd=fs.openSync(file,'r');
  try {
    const st=fs.fstatSync(fd);
    if(!st.isFile() || st.size>30*1024*1024) C.fail('Source is not a bounded file',413);
    const value=fs.readFileSync(fd);
    if(value.length>30*1024*1024) C.fail('Source exceeds limit',413);
    const final=fs.statSync(inside(root,rel));
    if(final.dev!==st.dev||final.ino!==st.ino||final.size!==st.size||final.mtimeMs!==st.mtimeMs)C.fail('Source changed while reading',409);
    return value;
  } finally { fs.closeSync(fd); }
}
function json(root,rel) { return JSON.parse(bytes(root,rel).toString('utf8')); }
function reader(root,args) {
  const manifest=json(root,MANIFEST), files={[MANIFEST]:JSON.stringify(manifest)},missing=[];
  if(args.kind==='report') {
    let hit;
    for(const batch of manifest.batches || []) for(const report of batch.reports || []) if(report.key===args.key) hit={batch,report};
    if(!hit) C.fail('Report not found',404);
    files[hit.report.md]=bytes(root,hit.report.md).toString('utf8');
    const optional=[hit.report.prevMd,...(hit.batch.noteLayers||[]).map(layer=>layer.file)].filter(Boolean);
    for(const rel of optional){try{files[rel]=bytes(root,rel).toString('utf8');}catch(error){if(error.code!=='ENOENT')throw error;missing.push(rel);}}
  }
  return {files,missing};
}
function exportAnnotations(root,kind,args) {
  if(C.digest(args.content)!==args.contentVersion) C.fail('Export version mismatch',409);
  const value=JSON.parse(args.content);
  if(!value || value.project!==args.projectId || value.key!==args.key) C.fail('Export identity mismatch',400);
  const rel=EXPORTS[kind]+'/'+args.key+'.json', file=inside(root,rel,true);
  fs.mkdirSync(path.dirname(file),{recursive:true}); inside(root,rel,true);
  // Content version is the idempotency identity; only this fixed filename is writable.
  atomic(file,value);
  return {ok:true,path:rel,...(kind==='reader'?{count:(value.annos||[]).length}:{}),contentVersion:args.contentVersion};
}
module.exports={inside,bytes,json,reader,exportAnnotations,MANIFEST,INDEX,EXPORTS};
