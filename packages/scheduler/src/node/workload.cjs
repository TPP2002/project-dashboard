'use strict';
// Executed only as the suspended root inside the native JobObject. Dependency
// installers and the menu command inherit that same JobObject and lease.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveWords } = require('./command.cjs');
const { contained } = require('./objects.cjs');
function satisfies(version, constraint) {
  const min = constraint.startsWith('>='), text = min ? constraint.slice(2) : constraint;
  if (!/^\d+(?:\.\d+){0,2}$/.test(text) || !min && text.split('.').length === 3) return false;
  const wanted = text.split('.').map(Number), actual = version.split('.').map(Number);
  if (!min) return wanted.every((x, i) => x === actual[i]);
  for (let i = 0; i < 3; i++) { if (actual[i] !== (wanted[i] ?? 0)) return actual[i] > (wanted[i] ?? 0); }
  return true;
}
async function run(words, cwd, env, timeoutMs, capture = false) {
  const command = await resolveWords(words, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let text = '', timer;
    child.stdout?.on('data', chunk => { text += chunk.toString(); if (text.length > 65536) reject(new Error('PROBE_OUTPUT_LIMIT')); });
    if (timeoutMs) timer = setTimeout(() => reject(new Error('deps-timeout')), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, text }); });
  });
}
async function main(file) {
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  const { project, cwd, directory } = plan;
  const env = { ...process.env, npm_config_cache: path.join(directory, 'npm-cache'),
    PIP_CACHE_DIR: path.join(directory, 'pip-cache'), PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  let python, venvPython;
  try {
    if (project.runtime.node && !satisfies(process.versions.node, project.runtime.node)) throw new Error('runtime-mismatch');
    if (project.runtime.python) {
      const probe = 'import json,sys; print(json.dumps([list(sys.version_info[:3]),sys.executable,sys.prefix != sys.base_prefix]))';
      for (const argv of [['python'], ['py', '-3']]) {
        try {
          const result = await run([...argv, '-c', probe], cwd, env, 10000, true);
          const [version, executable, isVenv] = JSON.parse(result.text);
          if (result.code === 0 && !isVenv && !/[\\/]WindowsApps[\\/]/i.test(executable)
            && satisfies(version.join('.'), project.runtime.python)) { python = executable; break; }
        } catch { /* Try the next original runtime candidate. */ }
      }
      if (!python) throw new Error('runtime-mismatch');
      const venv = path.join(cwd, '.venv');
      if ((await run([python, '-m', 'venv', venv], cwd, env, 300000)).code !== 0) throw new Error('deps-install-failed');
      venvPython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      env.VIRTUAL_ENV = venv; env.PATH = path.dirname(venvPython) + path.delimiter + (env.PATH ?? '');
    }
    for (const manifest of project.deps?.manifests ?? []) await contained(cwd, manifest);
    for (const recipe of project.deps?.install ?? []) {
      let argv, timeoutMs;
      if (recipe[0] === 'npm' && recipe.length === 2 && recipe[1] === 'ci') {
        argv = ['npm', 'ci', '--no-audit', '--no-fund']; timeoutMs = 1200000;
      } else if (recipe[0] === 'npm' && recipe.length === 4 && recipe[1] === '--prefix'
        && ['ci', 'install'].includes(recipe[3])) {
        await contained(cwd, recipe[2]); argv = [...recipe, '--no-audit', '--no-fund']; timeoutMs = 1200000;
      } else {
        const requirement = recipe[0] === 'pip' && recipe[1] === 'install' && recipe[2] === '-r' && recipe.length === 4
          ? recipe[3] : recipe[0] === 'python' && recipe[1] === '-m' && recipe[2] === 'pip'
            && recipe[3] === 'install' && recipe[4] === '-r' && recipe.length === 6 ? recipe[5] : null;
        if (!requirement || !venvPython) throw new Error('deps-recipe-unsupported');
        await contained(cwd, requirement);
        argv = [venvPython, '-m', 'pip', 'install', '-r', requirement, '--disable-pip-version-check', '--no-input']; timeoutMs = 1800000;
      }
      if ((await run(argv, cwd, env, timeoutMs)).code !== 0) throw new Error('deps-install-failed');
    }
    const result = await run(plan.words, cwd, { ...env, ...plan.env }, 0);
    // Preserve unknown exits in the supervisor record; never translate null to 0.
    await fs.writeFile(path.join(directory, 'workload-result.json'), JSON.stringify({ exitCode: result.code, signal: result.signal }), { flag: 'wx' });
    process.exit(result.code ?? 3);
  } catch (error) {
    const refused = ['runtime-mismatch', 'deps-timeout', 'deps-recipe-unsupported', 'deps-install-failed'].includes(error.message)
      ? error.message : 'deps-install-failed';
    await fs.writeFile(path.join(directory, 'workload-result.json'), JSON.stringify({ exitCode: 2, refused, detail: error.message }), { flag: 'wx' });
    process.stderr.write(`${error.message}\n`);
    // The outside controller observes root termination and kills remaining
    // installers through its own JobObject. No numeric-PID taskkill fallback.
    process.exit(2);
  }
}
if (require.main === module) main(process.argv[2]).catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
module.exports = { satisfies };
