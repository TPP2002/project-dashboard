'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createAuth, fail } = require('../core/collaborationAuth.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { mutate } = require('./store.cjs');
const { TASKID } = require('../core/boardSchema.cjs');
const { publicJson } = require('../core/collaborationPublic.cjs');
const { memberActions } = require('../core/collaborationRules.cjs');
const { taskTransition } = require('./commands.cjs');
const inputChannel = require('node:diagnostics_channel').channel('dashboard.collaboration-input');

const USAGE = `Collaboration local administration (DASHBOARD_HOME selects the data directory):
  node cli/collaboration.cjs init-owner --username <name> --password-file <path>
  init-owner --username <name> --password-file <path>
  reset-owner-password --username <name> --password-file <path>
  restore-auth-backup --confirm-restore
  revoke-all-credentials --confirm-revoke
  create-device --username <owner> --label <label> --token-file <new-path>
Only init-owner can create an empty installation; any existing ledger refuses bootstrap.
Stop the server before backup recovery. Recovery invalidates sessions, devices and invites.
After restoring a whole historical data backup, while still offline, run
  node cli/collaboration.cjs revoke-all-credentials --confirm-revoke
This revokes sessions/devices/invites in the CURRENT valid ledger and preserves
users, password hashes and project access. It never rebuilds or rolls back the ledger.
Password files must be regular, non-symlink, owner-only files (0600 on POSIX).
Passwords must be 6-128 characters; no character mixing is required.
On Windows protect the file and DASHBOARD_HOME with a private user/service account ACL.
Exactly one trailing newline is removed from password files; passwords never go in argv.
Device tokens go only to a newly created 0600 file, never stdout.
To serve: DASHBOARD_MODE=collaboration and DASHBOARD_PUBLIC_ORIGIN=<https-origin>
are required. Loopback HTTP is supported for private testing only. DASHBOARD_HOST
defaults to 127.0.0.1; explicitly use 0.0.0.0 for containers. A reverse proxy must
preserve Origin and strip Forwarded/X-Forwarded-* on writes (these are never trusted).
HTTP routes and response fields implement docs/plans/cloud-collaboration/contract.md;
no alternate endpoint, open registration, member administration or owner-by-body.
Internal HTTP task commands: create / note / claim / progress / unclaim / park /
unpark / done / cancel / reopen / join / leave / remove-collaborator.
join and leave accept no extra fields; remove-collaborator requires userId.
JSON on stdin includes sessionToken, actorId,
projectId and taskId (except create), plus only the documented command fields.
Members act only in granted projects; viewers cannot write tasks. No credential argv flags.
All signed-in roles may POST /api/auth/password. Owners issue 24-hour single-use
reset codes with POST /api/auth/users/:id/reset for members/viewers; redeem with
POST /api/auth/reset-password. Invitations and access accept member/viewer roles.
Internal owner-command accepts only stdin {sessionToken,args}; args are an allowlisted
legacy board command. It revalidates the owner under the auth lock before the
synchronous CLI board transaction. Never pass credentials as command arguments.`;

function readPassword(file) {
  if (typeof file !== 'string') fail(400, 'password-file required');
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2048 || (process.platform !== 'win32' && (st.mode & 0o077))) fail(400, 'Password file must be protected');
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}
async function readInternalInput(maxBytes = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'Input too large');
    chunks.push(chunk);
    if (chunks.length === 1 && inputChannel.hasSubscribers) inputChannel.publish({ bytes: size });
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid input'); }
}
function taskOperation(command, input, auth = createAuth()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid input');
  const fields = { create: ['title', 'plainTitle', 'description'], note: ['text'], claim: [], progress: ['percent', 'note'],
    unclaim: ['reason'], park: ['reason'], unpark: ['reason'], done: [], cancel: ['reason'], reopen: ['reason'],
    join: [], leave: [], 'remove-collaborator': ['userId'] };
  if (!Object.hasOwn(fields, command)) fail(403, 'Forbidden command');
  const keys = ['sessionToken', 'actorId', 'projectId', ...(command === 'create' ? [] : ['taskId']), ...fields[command]];
  if (Object.keys(input).some(k => !keys.includes(k))) fail(400, 'Unexpected field');
  if ((command !== 'create' && (typeof input.taskId !== 'string' || !TASKID.test(input.taskId))) || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 128) fail(400, 'Invalid task or project');
  const bounded = (value, max, required) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim()) || [...value].length > max) fail(400, 'Invalid text');
  };
  if (command === 'create') { bounded(input.title, 200, true); bounded(input.plainTitle, 200, false); bounded(input.description, 4000, false); }
  if (command === 'note') bounded(input.text, 2000, true);
  if (command === 'remove-collaborator') bounded(input.userId, 128, true);
  if (fields[command].includes('reason')) bounded(input.reason, 500, true);
  if (command === 'progress' && (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100 ||
      (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)))) fail(400, 'Invalid progress');
  return auth.withSession(input.sessionToken, ({ user }) => {
    if (input.actorId !== user.id) fail(403, 'Actor mismatch');
    if (user.role === 'viewer') fail(403, 'Forbidden');
    if (user.role !== 'owner' && !user.projectIds.includes(input.projectId)) fail(404, 'Not found');
    let proj;
    try { proj = resolveProject(input.projectId, { registryPath: process.env.DASHBOARD_REGISTRY || REGISTRY_PATH }); }
    catch { fail(404, 'Not found'); }
    let result;
    const clock = new Date(); const now = clock.toISOString();
    const date = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, '0')}-${String(clock.getDate()).padStart(2, '0')}`;
    let taskId = input.taskId;
    // Auth lock -> board lock, same order for every task. mutate re-reads the
    // board and applies schema validation and atomicWrite under its existing lock.
    const updatedBoard = mutate(proj, board => {
      if (command === 'create') {
        do { taskId = 'M' + date.replaceAll('-', '') + '-' + Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[crypto.randomInt(36)]).join(''); }
        while (board.tasks.some(t => t.id === taskId));
        const created = { id: taskId, title: input.title, status: '未开工', percent: 0, wave: 0, createdByUserId: user.id };
        for (const k of ['plainTitle', 'description']) if (input[k] !== undefined) created[k] = input[k];
        board.tasks.push(created);
        result = { ok: true, task: created };
        return;
      }
      let t = board.tasks.find(t => t.id === input.taskId);
      if (!t) fail(404, 'Not found');
      const action = command === 'remove-collaborator' ? 'removeCollaborator' : command;
      if (!memberActions(t, user).includes(action)) fail(409, 'Task operation is not available');
      if (command === 'join') {
        t.collaborators = [...(t.collaborators || []), { userId: user.id, name: user.displayName, joinedAt: now }];
      } else if (command === 'leave' || command === 'remove-collaborator') {
        const target = command === 'leave' ? user.id : input.userId;
        if (!(t.collaborators || []).some(c => c.userId === target)) fail(409, 'Collaborator not found');
        t.collaborators = t.collaborators.filter(c => c.userId !== target);
      } else if (command === 'claim') {
        // The shared rule above covers state, retained ownership, owner takeover
        // and unresolved decisions in the same locked snapshot as this write.
        t.assigneeUserId = user.id; t.assigneeName = user.displayName;
        if (t.collaborators) t.collaborators = t.collaborators.filter(c => c.userId !== user.id);
        t.status = '施工中';
        t.dates = t.dates || {}; if (!t.dates.start) t.dates.start = now.slice(0, 10);
        // builder and all AI dispatch/branch metadata remain exactly as recorded.
      } else if (command === 'progress') {
        if (user.role !== 'owner' && t.assigneeUserId !== user.id && !(t.collaborators || []).some(c => c.userId === user.id)) fail(409, 'Task is not assigned to you');
        if (t.status !== '施工中' || t.blockReason || (t.deps?.blockedBy || []).length) fail(409, 'Task is not active member work');
        t.percent = input.percent;
        if (input.note !== undefined) t.nextMilestone = input.note;
      } else if (command !== 'note') {
        const next = taskTransition(t, command, { reason: input.reason, date, now }).task;
        // Human ownership is separate from legacy AI branch ownership.
        if (command === 'unclaim') { delete next.assigneeUserId; delete next.assigneeName; }
        board.tasks[board.tasks.indexOf(t)] = next; t = next;
      }
      if (['claim', 'progress'].includes(command)) t.lastProgressAt = now;
      result = { ok: true, task: t };
    }, () => {
      const descriptions = { create: `新建任务 ${taskId}：${input.title}`, note: input.text, claim: 'Member claimed task', progress: 'Member updated progress',
        join: 'Member joined collaboration', leave: 'Member left collaboration', 'remove-collaborator': 'Removed collaborator',
        unclaim: `放弃认领 ${taskId}：${input.reason}`, park: `暂缓 ${taskId}：${input.reason}`, unpark: `复工 ${taskId}：${input.reason}`,
        done: `完工 ${taskId}`, cancel: `作废 ${taskId}：${input.reason}`, reopen: `重开 ${taskId}：${input.reason}` };
      return { ts: now, type: ['claim', 'progress', 'join', 'leave', 'remove-collaborator'].includes(command) ? 'collaboration:' + command : ['create', 'note'].includes(command) ? 'note' : command,
        taskId, userId: user.id, author: user.displayName, text: descriptions[command],
        ...(command === 'remove-collaborator' ? { targetUserId: input.userId } : {}),
        ...(command === 'note' ? { kind: 'message' } : {}), ...(command === 'progress' ? { percent: input.percent, note: input.note } : {}) };
    });
    result.task = require('../core/collaborationPublic.cjs').taskView(result.task, user, updatedBoard.activity || []);
    return result;
  });
}
// Keep this semantic allowlist narrower than the general CLI registry. The
// synchronous commands acquire their normal board locks inside the auth lock;
// no child process, Promise or asynchronous work is awaited while holding it.
function ownerOperation(input, auth = createAuth()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['sessionToken', 'args'].includes(k)) ||
      !Array.isArray(input.args) || input.args.some(a => typeof a !== 'string')) fail(400, 'Invalid owner command');
  const [command, ...args] = input.args;
  if (!['note', 'park', 'unpark', 'cancel', 'reopen', 'request-info', 'decide', 'undecide', 'mark-landed'].includes(command)) fail(403, 'Forbidden command');
  const { REGISTRY, parseFlags } = require('./index.cjs');
  const flags = parseFlags(args);
  // Registry comes from the server's private environment, not an internal body.
  flags.registry = process.env.DASHBOARD_REGISTRY || REGISTRY_PATH;
  return auth.withSession(input.sessionToken, ({ user }) => {
    if (user.role !== 'owner') fail(403, 'Forbidden');
    const [file, name] = REGISTRY[command];
    let result;
    try { result = require(file)[name](flags) || { ok: true }; }
    catch (e) { if (e.status) throw e; fail(400, e.message); }
    // Match the existing CLI --json summary contract.
    const t = result.task;
    return t ? { ok: result.ok !== false, id: t.id, status: t.status, percent: t.percent || 0, changed: result.changed || [] } : result;
  });
}
async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help') { console.log(USAGE); return; }
  const command = args.shift();
  if (command === 'owner-command') {
    if (args.length) fail(400, 'Internal owner commands accept stdin only');
    console.log(JSON.stringify(ownerOperation(await readInternalInput(2 * 1024 * 1024)), publicJson)); return;
  }
  if (['create', 'note', 'claim', 'progress', 'unclaim', 'park', 'unpark', 'done', 'cancel', 'reopen', 'join', 'leave', 'remove-collaborator'].includes(command)) {
    if (args.length) fail(400, 'Internal task commands accept stdin only');
    console.log(JSON.stringify(taskOperation(command, await readInternalInput(65536)))); return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--confirm-restore' || key === '--confirm-revoke') options[key] = true;
    else if (['--username', '--password-file', '--label', '--token-file'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else fail(400, 'Unknown argument; see --help');
  }
  const auth = createAuth();
  if (command === 'init-owner') await auth.bootstrap(options['--username'], readPassword(options['--password-file']));
  else if (command === 'reset-owner-password') await auth.resetOwner(options['--username'], readPassword(options['--password-file']));
  else if (command === 'restore-auth-backup' && options['--confirm-restore']) auth.restoreBackup();
  else if (command === 'revoke-all-credentials' && options['--confirm-revoke']) auth.revokeAllCredentials();
  else if (command === 'create-device') {
    if (!options['--token-file']) fail(400, 'token-file required');
    const fd = fs.openSync(options['--token-file'], 'wx', 0o600);
    try { const result = auth.localDevice(options['--username'], options['--label']); fs.writeFileSync(fd, result.token + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } else fail(400, 'Unknown command; see --help');
  console.log(JSON.stringify({ ok: true }));
}
if (require.main === module) main().catch(e => { console.log(JSON.stringify({ ok: false, status: e.status || 500, error: e.status ? e.message : 'Operation failed' })); process.exitCode = 1; });
module.exports = { main, readPassword, taskOperation, ownerOperation };
