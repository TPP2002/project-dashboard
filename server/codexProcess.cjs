'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODEX_SCRIPT = 'scripts/codex/codex-dispatch.ts';
const DEFAULT_CODEX_BIN = path.join(process.env.LOCALAPPDATA || os.homedir(), 'OpenAI', 'Codex', 'bin');
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Windows 必须经 cmd.exe 启动 npx.cmd；不能直接 spawn .cmd。 */
function spawnDispatchCli(repo, args, options = {}) {
  const cliArgs = ['tsx', CODEX_SCRIPT, ...args];
  const base = { cwd: repo, windowsHide: true, shell: false, ...options };
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx', ...cliArgs], base)
    : spawn('npx', cliArgs, base);
}

function listCodexExecutables(root = DEFAULT_CODEX_BIN) {
  const found = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') {
        try {
          const stat = fs.statSync(full);
          found.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch (_) { /* 目录可能在扫描中被升级器替换。 */ }
      }
    }
  }
  walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findCodexExecutable(root = DEFAULT_CODEX_BIN) {
  return listCodexExecutables(root)[0]?.path || null;
}

function buildSessionResumeArgs(sessionId, message, sandboxMode) {
  const mode = sandboxMode === 'workspace-write' ? 'workspace-write' : 'read-only';
  return [
    'exec', 'resume', sessionId, message,
    '--skip-git-repo-check', '-c', `sandbox_mode="${mode}"`,
  ];
}

function spawnSessionResume({ executable, sessionId, message, sandboxMode, cwd }) {
  return spawn(executable, buildSessionResumeArgs(sessionId, message, sandboxMode), {
    cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForChild(child, callback, timeoutMs = COMMAND_TIMEOUT_MS) {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(result);
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch (_) {}
    finish({ kind: 'timeout', stdout, stderr });
  }, timeoutMs);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => finish({ kind: 'spawn', error, stdout, stderr }));
  child.once('close', (code) => finish({ kind: 'exit', code, stdout, stderr }));
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  DEFAULT_CODEX_BIN,
  buildSessionResumeArgs,
  findCodexExecutable,
  listCodexExecutables,
  spawnDispatchCli,
  spawnSessionResume,
  waitForChild,
};
