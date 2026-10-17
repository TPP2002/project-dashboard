'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = require('../core/boardCommand.cjs');
const config = require('./remoteConfig.cjs');
const {withLock} = require('../core/lock.cjs');
const {atomicWriteJsonSync} = require('../core/atomicWrite.cjs');
function identifier(id) {
  // IDs become an administrator-derived directory segment, never a client path.
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || ['constructor','prototype','__proto__'].includes(id)) throw new Error('非法项目ID');
  return id;
}
function bindingInput(file,id) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('必须指定本机 --binding-file 或 --remote-binding');
  const value = JSON.parse(require('./remoteClient.cjs').textInput(file));
  const b = config.validateConfig({version:1,projects:{[identifier(id)]:value}}).projects[id];
  require('./remoteClient.cjs').transportSpec(b);
  if (typeof b.repoBindingId !== 'string' || !b.repoBindingId) throw new Error('缺少本机仓绑定标识');
  return b;
}
function initOnAuthority(request,a) {
  p.validate(request);
  if (a.admin !== true || request.command !== 'project-init' || request.authorityId !== a.authorityId || request.authorityEpoch !== a.authorityEpoch) throw new Error('仅固定owner管理员入口可初始化项目');
  const id = identifier(request.projectId), name = request.args.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('项目展示名需1至200字');
  const root = path.join(path.resolve(a.home),'projects',id);
  if (!require('./projectBoard.cjs').inside(a.home,root)) throw new Error('项目目录实际路径超出管理员数据根');
  const board = path.join(root,'board.json');
  const registryPath = path.resolve(a.registryPath);
  fs.mkdirSync(path.dirname(registryPath),{recursive:true,mode:0o700});
  return withLock(registryPath + '.lock',() => {
    const registry = require('../core/resolveProject.cjs').readRegistry(registryPath);
    const existing = registry.projects?.[id];
    if (existing) {
      if (path.resolve(existing.board || '') !== board || existing.name !== name) throw new Error('项目已存在，禁止覆盖或清空；迁移由主控专门执行');
      require('../core/boardSchema.cjs').assertValid(JSON.parse(fs.readFileSync(board,'utf8')));
      return {ok:true,id,existed:true};
    }
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const manifestPath = path.join(root,'initialization.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!manifest) {
      if (fs.existsSync(board)) throw new Error('云端已有未登记账本，禁止自动接管');
      manifest = {id,name,board:require('../core/boardSchema.cjs').emptyBoard({id,name,mainRepo:root})};
      config.initialize(manifestPath,manifest);
    }
    if (manifest.id !== id || manifest.name !== name) throw new Error('初始化恢复清单不匹配');
    if (!fs.existsSync(board)) config.initialize(board,manifest.board);
    else if (p.inputHash(JSON.parse(fs.readFileSync(board,'utf8'))) !== p.inputHash(manifest.board)) throw new Error('未登记账本已经变化，禁止初始化覆盖');
    registry.projects = registry.projects || {};
    registry.projects[id] = {name,mainRepo:root,board};
    atomicWriteJsonSync(registryPath,registry);
    return {ok:true,id,created:true}; // Does not grant repoBindings or member permissions.
  });
}
function initializeRemote(flags) {
  for (const key of Object.keys(flags)) if (!['_','id','name','binding-file','request-id','json'].includes(key)) throw new Error('管理员初始化不接受参数: ' + key);
  const id = identifier(flags.id), binding = bindingInput(flags['binding-file'],id);
  const client = require('./remoteClient.cjs');
  let r;
  if (flags['request-id']) {
    r = require('./remoteOutbox.cjs').read(flags['request-id']).request;
    if (r.requestId !== flags['request-id'] || r.command !== 'project-init' || r.projectId !== id) throw new Error('初始化待送请求不匹配');
  } else r = {version:p.VERSION,authorityId:binding.authorityId,authorityEpoch:binding.authorityEpoch,requestId:require('../core/boardCommandRetention.cjs').requestId(),projectId:id,command:'project-init',args:{_:[],name:flags.name}};
  if (r.authorityId !== binding.authorityId || r.authorityEpoch !== binding.authorityEpoch) throw new Error('初始化属于旧权威');
  p.validate(r);
  require('./remoteOutbox.cjs').save(r);
  try {
    const result = client.send(r,binding);
    require('./remoteOutbox.cjs').acknowledge(r.requestId);
    return result;
  } catch (e) { throw new Error(e.message + '；结果待核对 requestId=' + r.requestId + '；使用同一管理员绑定文件和 --request-id 重试，禁止换号'); }
}
function bind(flags) {
  const id = identifier(flags.id);
  if (typeof flags.root !== 'string' || !flags.root.trim()) throw new Error('绑定需显式 --root <本机仓库>');
  if (flags.update !== undefined && flags.update !== true) throw new Error('--update 必须是显式开关');
  if (flags.board !== undefined && (typeof flags.board !== 'string' || !flags.board.trim())) throw new Error('--board 必须是本机路径');
  if (flags.name !== undefined && (typeof flags.name !== 'string' || !flags.name.trim())) throw new Error('--name 必须是展示名');
  const b = bindingInput(flags['binding-file'] || flags['remote-binding'],id);
  const r = {version:p.VERSION,authorityId:b.authorityId,authorityEpoch:b.authorityEpoch,requestId:require('../core/boardCommandRetention.cjs').requestId(),projectId:id,command:'projection',args:{_:[]}};
  const cloud = require('./remoteClient.cjs').send(r,b).board;
  if (!cloud || cloud.project?.id !== id) throw new Error('云端项目身份不匹配');
  const {REGISTRY_PATH,readRegistry} = require('../core/resolveProject.cjs');
  const registryPath = flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH;
  const file = path.resolve(config.configPath());
  if (file === path.resolve(registryPath)) throw new Error('绑定配置不可与本机注册表同路径');
  const registered = readRegistry(registryPath).projects?.[id];
  if (registered && !flags.update) throw new Error('本机项目登记已存在，绑定需显式 --update（旧板保持原样）');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.mkdirSync(path.dirname(registryPath),{recursive:true});
  withLock(registryPath + '.lock',() => withLock(file + '.lock',() => {
    const reg = readRegistry(registryPath), old = reg.projects?.[id];
    if (old && !flags.update) throw new Error('本机登记并发创建，更新须显式 --update');
    let current = {version:1,projects:{}};
    if (fs.existsSync(file)) current = config.load();
    if (Object.hasOwn(current.projects,id) && !flags.update) throw new Error('绑定已存在，更新须显式 --update');
    current.projects[id] = b;
    config.validateConfig(current);
    if (fs.existsSync(file)) atomicWriteJsonSync(file,current); else config.initialize(file,current);
    if (process.platform !== 'win32') fs.chmodSync(file,0o600);
    const repo = path.resolve(flags.root);
    reg.projects = reg.projects || {};
    reg.projects[id] = {...old,name:flags.name || cloud.project.name,mainRepo:old?.mainRepo || repo,codeRepo:repo,board:flags.board ? path.resolve(flags.board) : old?.board || path.join(repo,'.dashboard','board.json')};
    atomicWriteJsonSync(registryPath,reg);
  }));
  return {ok:true,id,text:`✔ 已绑定远程项目 ${id}；本机仅登记仓库和旧路径，未创建或改写本机账本`};
}
module.exports = { bind, initializeRemote, initOnAuthority };
