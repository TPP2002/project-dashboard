'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const deployment = require('../sched/client/deployment-config.cjs');
const { contained } = require('./objects.cjs');

async function executable(word, cwd) {
  if (word === 'node' || word === 'node.exe') return process.execPath;
  const roots = /[\\/]/.test(word) ? [''] : [cwd, ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const root of roots) for (const suffix of ['', '.exe']) {
    const candidate = path.resolve(root || cwd, word + suffix);
    if (!/\.exe$/i.test(candidate)) continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw new Error('CONFIGURED_EXECUTABLE_MISSING');
}
async function commandFromCatalog({ project: id, job, machine, codeRef, share, worktree, deferTools = false }) {
  const project = deployment.getDeploymentConfig().projects.find(x => x.id === id);
  if (!project?.accepted || !project.machines.includes(machine) || !path.isAbsolute(project.repo)) throw new Error('PROJECT_NOT_AUTHORIZED');
  const cwd = await contained(worktree ?? project.repo, '.');
  const domain = require('../bot/cluster-job.js');
  const check = domain.validateJob(job);
  if (!check.ok) throw new Error(`JOB_INVALID:${check.reason}`);
  let words, env = {}, item;
  if (job.auto) {
    const menu = require('../sched/client/sched-menu.cjs');
    if (job.auto.project !== id) throw new Error('AUTO_PROJECT');
    const checked = menu.validateMenuArgs(id, job.auto.item, job.auto.args);
    if (!checked.ok) throw new Error(`MENU_ARGS:${checked.why}`);
    item = project.menu.find(x => x.id === job.auto.item);
    if (!item?.portable) throw new Error('MENU_NOT_PORTABLE');
    // Forms are administrator-owned argv templates. Only an exact round-trip
    // through the original classifier can select a template; no shell payload.
    for (const form of item.forms) {
      let tail = [...job.auto.args];
      if (form.emit?.length) {
        if (!form.emit.every((v, i) => tail[i] === v)) continue;
        tail = tail.slice(form.emit.length);
      }
      tail = [...(form.require ?? []), ...tail];
      if (form.drop?.includes('maxWorkers')) tail.push(`--maxWorkers=${job.grantedCores}`);
      const candidate = [...form.cmd, ...(form.tail === 'npm' && tail.length ? ['--'] : []), ...tail];
      const recognized = menu.classifyCommand(id, candidate);
      if (recognized.recognized && recognized.item === item.id && JSON.stringify(recognized.args) === JSON.stringify(job.auto.args)) {
        words = candidate; break;
      }
    }
    if (!words) throw new Error('MENU_RESTORE_TEMPLATE_MISSING');
  } else {
    item = project.menu.find(x => x.id === job.kind);
    if (!item) throw new Error('PROJECT_MENU_ITEM_MISSING');
    const restored = domain.resolveCommand(job, { sharePath: share, quotaCores: job.grantedCores });
    words = [restored.bin, ...restored.args]; env = restored.env;
  }
  if (deferTools) return { words, cwd, env, item };
  return { ...await resolveWords(words, cwd), cwd, env, item, ...await verifyCode(cwd, codeRef) };
}
async function resolveWords(input, cwd) {
  let words = [...input];
  if (words[0] === 'npm') {
    let npm;
    for (const root of [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]) {
      const candidate = path.join(root, 'node_modules/npm/bin/npm-cli.js');
      try { if ((await fs.stat(candidate)).isFile()) { npm = candidate; break; } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (!npm) throw new Error('NPM_CLI_MISSING');
    words = [process.execPath, npm, ...words.slice(1)];
  } else if (words[0] === 'npx') {
    const tool = words[1];
    if (!/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+$/.test(tool)) throw new Error('CONFIGURED_TOOL_NAME');
    const packageName = tool === 'tsc' ? 'typescript' : tool === 'playwright' ? '@playwright/test' : tool;
    const packageFile = await contained(cwd, path.join('node_modules', packageName, 'package.json'));
    const spec = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const bin = typeof spec.bin === 'string' ? spec.bin : spec.bin?.[tool.split('/').at(-1)];
    if (typeof bin !== 'string') throw new Error('INSTALLED_TOOL_BIN_MISSING');
    const entry = await contained(path.dirname(packageFile), bin);
    words = [process.execPath, entry, ...words.slice(2)];
  }
  return { executable: await executable(words[0], cwd), args: words.slice(1) };
}
async function verifyCode(cwd, codeRef) {
  if (codeRef.kind !== 'commit') throw new Error('ORIGINAL_CONTENT_TARGETS_REQUIRED');
  const head = await new Promise((resolve, reject) => execFile('git', ['rev-parse', '--verify', 'HEAD'],
    { cwd, windowsHide: true, timeout: 12000, maxBuffer: 4096, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  if (head !== codeRef.value) throw new Error('PROJECT_CODE_REF_MISMATCH');
  return {};
}
function jobEnvironment({ command, directory, identity, cores, source = process.env }) {
  // Preserve the original menu environment allowlist; the gateway's secrets and
  // Node loader options must not leak into an arbitrary configured workload.
  const names = new Set(['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'ProgramData',
    'PUBLIC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'COMPUTERNAME', 'USERNAME',
    'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA']);
  for (const name of command.item.env) if (!/TOKEN|SECRET|PASSW|CREDENTIAL|APIKEY|API_KEY|PRIVATE|(?:^|_)PROXY$|^npm_config_|^PIP_|^NODE_OPTIONS$/i.test(name)
    && !['UDQ_TIMING_OUT', 'UDQ_SELECTION'].includes(name)) names.add(name);
  const result = {};
  for (const name of names) {
    const key = Object.keys(source).find(k => k.toLowerCase() === name.toLowerCase());
    if (key) result[name] = source[key];
    else if (name === 'PLAYWRIGHT_BROWSERS_PATH') {
      const local = Object.keys(source).find(k => k.toLowerCase() === 'localappdata');
      if (local) {
        const browsers = path.join(source[local], 'ms-playwright');
        if (require('node:fs').existsSync(browsers)) result[name] = browsers;
      }
    }
  }
  // Pin libuv's Windows-required keys instead of allowing it to fill omitted
  // values from the gateway process when creating a workload.
  for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'])
    if (!Object.keys(result).some(k => k.toUpperCase() === key)) result[key] = '';
  return { ...result, ...command.env, TEMP: directory, TMP: directory, LOCALAPPDATA: directory,
    SCHED_MODE: 'remote', SCHED_PERMIT: `${identity.ticketId}:${identity.attemptId}:${identity.permitToken}`,
    SCHED_GRANTED_CORES: String(cores), npm_config_update_notifier: 'false' };
}
module.exports = { commandFromCatalog, jobEnvironment, resolveWords };
