'use strict';
const protocol = require('../core/boardCommand.cjs');
const cmds = require('./commands.cjs');
const EXTRA = { brief: ['./brief.cjs','brief'], inbox: ['./inboxCmd.cjs','inbox'], undecide: ['./undecide.cjs','undecide'], 'request-info': ['./requestInfo.cjs','requestInfo'], backfill: ['./backfill.cjs','backfill'] };
const NAMES = { 'await-collect':'awaitCollect', 'collect-brief':'collectBrief', 'mark-landed':'markLanded' };
function gates(command, flags) {
  if (command === 'add' && !cmds.isBatchAdd(flags)) {
    const missing = key => typeof flags[key] !== 'string' || !flags[key].trim();
    // Preserve the original CLI's order and recovery guidance at both entry points.
    if (missing('model')) throw new Error('建卡必须带 --model <建议档位>(0901 拍板,机器闸)。按模型路由表照抄一个:\n' +
      '  机械执行/清单/一行修 → --model "sonnet·低"\n' +
      '  照单施工/接线/修复   → --model "opus·中"\n' +
      '  设计/评审/校准/疑难  → --model "fable·高"\n' +
      '  负责人亲办不开对话   → --model "负责人本人办"\n' +
      '  (编排型可组合,如 "fable·高编排+opus施工";≤40 字符)');
    if (missing('plain-title')) throw new Error('建卡必须带 --plain-title <人话标题>(建卡三件套,机器闸)。\n' +
      '  --title 给模型看技术详细说明，--plain-title 给负责人看一句人话；两者都要给。\n' +
      '  可加 --scope "<glob>"（可重复）登记文件范围。');
    if (missing('title')) throw new Error('建卡必须带 --title <技术说明>（建卡三件套机器闸）');
  }
  if (command === 'done') { const refusal = cmds.costGateRefusal(flags); if (refusal) throw new Error(refusal); }
}
function execute(command, flags) {
  gates(command, flags);
  const extra = EXTRA[command];
  const fn = extra ? require(extra[0])[extra[1]] : cmds[NAMES[command] || command];
  if (!fn) throw new Error('未适配语义命令: ' + command);
  return fn(flags) || { ok: true };
}
function run(request, context) {
  protocol.validate(request);
  if (request.command === 'project-init') throw new Error('项目初始化只接受固定管理员入口');
  const { authority, subject, registryPath } = context;
  if (!subject || subject.role !== 'owner' || !subject.id || subject.id !== authority.ownerId) throw new Error('仅受信 owner 传输主体可调用');
  if (request.authorityId !== authority.authorityId || request.authorityEpoch !== authority.authorityEpoch) throw new Error('权威或代际不匹配');
  if (!Object.hasOwn(authority.projects, request.projectId)) throw new Error('项目不在 authority 许可内');
  const { resolveProject } = require('../core/resolveProject.cjs');
  const proj = resolveProject(request.projectId, { registryPath });
  const flags = { ...request.args, _: request.args._ || [], project: request.projectId, registry: registryPath };
  if (Object.hasOwn(flags, 'payload')) { flags._payload = flags.payload; delete flags.payload; }
  const fn = () => {
    if (request.command === 'projection') return { ok: true, board: require('./store.cjs').readBoard(proj.board) };
    if (request.command === 'claim-evidence') return require('./remoteMaintenance.cjs').claimEvidence(proj);
    if (request.command === 'branch-cleanup') return require('./remoteMaintenance.cjs').cleanup(proj, flags._payload);
    if (request.command === 'set') require('../core/boardCommandTasks.cjs').field(flags.field);
    if (request.command === 'backfill-patch') return require('./backfill.cjs').backfill({...flags,patch:undefined});
    if (request.command === 'import-batch') return require('./remoteAdmin.cjs').importBatch(proj,flags._payload,flags.author);
    if (request.command === 'archive-activity') return require('./archiveActivity.cjs').archiveActivity({...flags,_remoteArchive:true});
    if (request.command === 'audit-card') {
      if (!/^DOCS-AUDIT-[0-9]{6}$/.test(flags._[0])) throw new Error('非法月度巡检卡编号');
      gates('add',flags);
      const existing = require('./store.cjs').readBoard(proj.board).tasks.find(t => t.id === flags._[0]);
      return existing ? {ok:true,task:existing,existed:true} : execute('add',flags);
    }
    if (request.command === 'git-facts') return require('./gitFacts.cjs').merge(proj, flags.facts, authority.projects[request.projectId], subject);
    if (request.command === 'claim-check') {
      const board = require('./store.cjs').readBoard(proj.board);
      const hits = (board.tasks || []).filter(t => ['施工中','待收单'].includes(t.status) && (t.gitBranch || []).includes(flags.branch)).map(t => ({project:proj.id,taskId:t.id,status:t.status,percent:t.percent || 0,title:t.title}));
      return { ok: true, hits };
    }
    if (request.command === 'sync-progress') return require('./gitFacts.cjs').progress(proj, flags.branch, flags.percent);
    return execute(request.command, flags);
  };
  if (protocol.READ.has(request.command)) return protocol.publicResult(fn());
  return require('./store.cjs').commandTransaction(proj, { subject: subject.id, request, receiptPolicy: authority.receiptPolicy, inputHash: protocol.inputHash(request) }, fn);
}
module.exports = { gates, execute, run };
