'use strict';
/**
 * identifierCheck.cjs —— 公开仓提交前的本机标识 / 盘符路径检查（pre-commit 的 identifier-gate 调它）。
 *
 * 仓根带 .public-repo 标记的仓才查；默认查 git add 过的暂存内容（从索引取，不读工作区同名文件），
 * --all 改查工作区全部文件。命中只报「文件名:行号 + 命中名单第几条 / 白名单以外的盘符路径」，
 * 绝不把名单里的词或命中的原文打印出来。名单是可选的本机数据，读不到时仍照查路径形状。
 *
 * 只读命令：不起 git 以外的子进程、不联网、不写文件。命中 → 退出码 1；无命中 → 退出码 0、不打印。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const {
  BINARY_EXTENSIONS, readForbiddenTokens, findTokenHits, findBadPaths,
} = require('../core/localIdentifierScan.cjs');

const MARKER = '.public-repo';
const FORBIDDEN_FILE = path.join(DASHBOARD_HOME, 'opensource-forbidden.txt');
const MISSING_LIST_LINE = '本机没有标识名单，这次只查了盘符路径';
const GIT_OPTS = { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 };

function git(cwd, args) {
  return spawnSync('git', args, { ...GIT_OPTS, cwd });
}

function skip() { return { silent: true }; }

function isBinary(file) {
  return BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** 暂存区：按 ACMR 列出文件，内容从索引取（git show :路径），不读工作区同名文件。 */
function stagedFiles(root) {
  const r = git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  if (r.error || r.status !== 0) return [];
  const files = [];
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    if (isBinary(file)) continue;
    const shown = git(root, ['show', ':' + file]);
    if (shown.error || shown.status !== 0) continue;
    files.push({ file, content: shown.stdout });
  }
  return files;
}

/** 工作区：已跟踪 + 未跟踪但未被忽略的全部文件，内容直接读工作区。 */
function worktreeFiles(root) {
  const r = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.error || r.status !== 0) return [];
  const files = [];
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    if (isBinary(file)) continue;
    let content;
    try { content = fs.readFileSync(path.join(root, file), 'utf8'); }
    catch { continue; }
    files.push({ file, content });
  }
  return files;
}

/** 从 findBadPaths 的「文件:行号: 路径」里只取出文件与行号，不把命中的路径原文带进报告。 */
function pathReportLine(violation) {
  const m = violation.match(/^(.*?):(\d+): /);
  return m ? `${m[1]}:${m[2]} 白名单以外的盘符路径` : null;
}

/**
 * identifier-check：查本机标识与白名单以外的盘符路径。
 * @param {{force?:boolean, all?:boolean}} flags
 */
function identifierCheck(flags) {
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return skip();
  const root = top.stdout.trim();
  if (!root) return skip();
  if (!flags.force && !fs.existsSync(path.join(root, MARKER))) return skip();

  const tokens = readForbiddenTokens(FORBIDDEN_FILE);
  if (tokens.length === 0) process.stderr.write(MISSING_LIST_LINE + '\n');

  const files = flags.all ? worktreeFiles(root) : stagedFiles(root);
  const tokenHits = findTokenHits(tokens, files);
  const pathHits = findBadPaths(files);

  const lines = [];
  for (const h of tokenHits) lines.push(`${h.file}:${h.line} 命中标识名单第 ${h.tokenIndex} 条`);
  for (const v of pathHits) {
    const line = pathReportLine(v);
    if (line) lines.push(line);
  }
  if (!lines.length) return skip();
  for (const line of lines) process.stderr.write(line + '\n');
  process.stderr.write(`共 ${lines.length} 处：改掉后重新 git add；确属占位写法的去 core/localIdentifierScan.cjs 的白名单里登记\n`);
  process.exitCode = 1;
  return skip();
}

module.exports = { identifierCheck };
