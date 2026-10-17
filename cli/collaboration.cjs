'use strict';
const fs = require('node:fs');
const { createAuth, fail } = require('../core/collaborationAuth.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { mutate } = require('./store.cjs');
const { TASKID } = require('../core/boardSchema.cjs');
const { publicJson } = require('../core/collaborationPublic.cjs');
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
On Windows protect the file and DASHBOARD_HOME with a private user/service account ACL.
Exactly one trailing newline is removed from password files; passwords never go in argv.
Device tokens go only to a newly created 0600 file, never stdout.
To serve: DASHBOARD_MODE=collaboration and DASHBOARD_PUBLIC_ORIGIN=<https-origin>
are required. Loopback HTTP is supported for private testing only. DASHBOARD_HOST
defaults to 127.0.0.1; explicitly use 0.0.0.0 for containers. A reverse proxy must
preserve Origin and strip Forwarded/X-Forwarded-* on writes (these are never trusted).
HTTP routes and response fields implement docs/plans/cloud-collaboration/contract.md;
no alternate endpoint, open registration, member administration or owner-by-body.
Internal HTTP task commands: claim / progress; JSON on stdin includes sessionToken,
actorId, projectId, taskId and (progress only) percent/note. No credential argv flags.
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
  const keys = ['sessionToken', 'actorId', 'projectId', 'taskId', ...(command === 'progress' ? ['percent', 'note'] : [])];
  if (Object.keys(input).some(k => !keys.includes(k))) fail(400, 'Unexpected field');
  if (typeof input.taskId !== 'string' || !TASKID.test(input.taskId) || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 128) fail(400, 'Invalid task or project');
  if (command === 'progress' && (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100 ||
      (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)))) fail(400, 'Invalid progress');
  return auth.withSession(input.sessionToken, ({ user }) => {
    if (input.actorId !== user.id) fail(403, 'Actor mismatch');
    if (user.role !== 'owner' && !user.projectIds.includes(input.projectId)) fail(404, 'Not found');
    let proj;
    try { proj = resolveProject(input.projectId, { registryPath: process.env.DASHBOARD_REGISTRY || REGISTRY_PATH }); }
    catch { fail(404, 'Not found'); }
    let result;
    const now = new Date().toISOString();
    // Auth lock -> board lock, same order for every task. mutate re-reads the
    // board and applies schema validation and atomicWrite under its existing lock.
    mutate(proj, board => {
      const t = board.tasks.find(t => t.id === input.taskId);
      if (!t) fail(404, 'Not found');
      if (command === 'claim') {
        if (t.assigneeUserId || !['未开工', '待开工', '可复工', '已拍板'].includes(t.status) ||
            (t.decisions || []).some(d => d.answer === null || d.answer === undefined)) fail(409, 'Task is not available');
        t.assigneeUserId = user.id; t.assigneeName = user.displayName;
        t.status = '施工中';
        t.dates = t.dates || {}; if (!t.dates.start) t.dates.start = now.slice(0, 10);
        // builder and all AI dispatch/branch metadata remain exactly as recorded.
      } else {
        if (t.assigneeUserId !== user.id) fail(409, 'Task is not assigned to you');
        if (t.status !== '施工中' || t.blockReason || (t.deps?.blockedBy || []).length) fail(409, 'Task is not active member work');
        t.percent = input.percent;
        if (input.note !== undefined) t.nextMilestone = input.note;
      }
      t.lastProgressAt = now;
      result = { ok: true, task: { id: t.id, status: t.status, percent: t.percent || 0, assigneeUserId: t.assigneeUserId, assigneeName: t.assigneeName } };
    }, { ts: now, type: 'collaboration:' + command, taskId: input.taskId, userId: user.id, author: user.displayName,
      text: command === 'claim' ? 'Member claimed task' : 'Member updated progress', ...(command === 'progress' ? { percent: input.percent, note: input.note } : {}) });
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
  if (['claim', 'progress'].includes(command)) {
    if (args.length) fail(400, 'Internal task commands accept stdin only');
    console.log(JSON.stringify(taskOperation(command, await readInternalInput()))); return;
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
