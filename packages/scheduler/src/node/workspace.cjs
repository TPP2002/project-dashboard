'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const snapshot = require('../sched/client/sched-snapshot.cjs');
const deployment = require('../sched/client/deployment-config.cjs');
const { contained, bindingKey } = require('./objects.cjs');

function git(cwd, args, signal) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'USERNAME', 'USERPROFILE']) {
    const actual = Object.keys(process.env).find(k => k.toLowerCase() === key.toLowerCase());
    env[key] = actual ? process.env[actual] : '';
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=', ...args],
    { cwd, env, signal, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
// A private mirror per attempt avoids rewriting the administrator's repository,
// touching its dependencies, or reusing an uncertain previous execution tree.
async function prepareWorkspace({ config, publication, reader, signal }) {
  const { submission, permit } = publication;
  const project = deployment.getDeploymentConfig().projects.find(x => x.id === submission.project);
  if (!project?.accepted || !project.machines.includes(config.machine) || !path.isAbsolute(project.repo)) throw new Error('PROJECT_NOT_AUTHORIZED');
  const identity = { ticketId: permit.ticketId, attemptId: permit.attemptId, permitToken: permit.token };
  const directory = path.join(config.stateRoot, 'workspaces', bindingKey(identity));
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory); // Existing directory is uncertain, never clean/reset it.
  await contained(config.stateRoot, path.relative(config.stateRoot, directory));
  const mirror = path.join(directory, 'repo.git'), cwd = path.join(directory, 'worktree');
  const source = await contained(project.repo, '.');
  await git(directory, ['clone', '--bare', '--no-hardlinks', '--no-local', source, mirror], signal);
  let commit = publication.codeRef.value;
  if (publication.snapshot) {
    const metadata = publication.snapshot;
    const read = await reader.read([{ kind: 'snapshot-bundle', ticketId: permit.ticketId, attemptId: permit.attemptId }]);
    const selected = read.objects.filter(x => x.entry.kind === 'snapshot-bundle'
      && x.entry.ticketId === permit.ticketId && x.entry.attemptId === permit.attemptId);
    if (selected.length !== 1) throw new Error('SNAPSHOT_BUNDLE_UNAVAILABLE');
    const { entry, value } = selected[0];
    if (!Buffer.isBuffer(value) || entry.contentType !== 'application/octet-stream'
      || entry.object.hash !== metadata.object.hash || entry.object.size !== metadata.object.size
      || value.length !== metadata.bundleBytes || value.length !== entry.object.size
      || createHash('sha256').update(value).digest('hex') !== entry.object.hash) throw new Error('SNAPSHOT_BUNDLE_IDENTITY');
    // Cloud assigns a new immutable objectId. Content hash and length bind it to
    // the authenticated publication; the origin's objectId is not its identity.
    const bundlePath = path.join(directory, `${permit.ticketId}.bundle`);
    const fd = await fs.open(bundlePath, 'wx');
    try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); }
    if (signal?.aborted) throw new Error('EXECUTOR_ABORTED');
    const imported = await snapshot.fetchSnapshot({ mirrorPath: mirror, bundlePath, ticketId: permit.ticketId,
      expectedCommit: metadata.commit, timeoutMs: 120000 });
    if (!imported.ok) throw new Error(`${imported.reason}:${imported.detail}`);
    commit = imported.commit;
  } else if (publication.codeRef.kind !== 'commit') throw new Error('CONTENT_SNAPSHOT_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('WORKSPACE_COMMIT');
  await git(mirror, ['worktree', 'add', '--detach', cwd, commit], signal);
  if (await git(cwd, ['rev-parse', 'HEAD'], signal) !== commit) throw new Error('WORKSPACE_HEAD');
  await contained(directory, 'worktree');
  for (const manifest of project.deps?.manifests ?? []) await contained(cwd, manifest);
  return { cwd, directory, project, commit };
}
module.exports = { prepareWorkspace };
