'use strict';
/**
 * localIdentifierScan.cjs —— 公开仓的本机标识 / 盘符路径扫描（纯扫描，不读名单以外的本机数据）。
 *
 * 这段逻辑原先整份住在 test/noLocalIdentifiers.test.cjs 里：名单闸按本机名单文件逐字比对，
 * 路径形状闸不依赖名单、只放行仓内占位符与标准软件安装路径。现在搬到这里，让测试和
 * cli/identifierCheck.cjs 共用同一份实现；行为与搬之前逐字等价。
 *
 * findTokenHits 是新增的「按行定位」：判定口径与 findViolations 完全相同（先去掉本文件在
 * TEXT_ALLOWLIST 里放行的串、反斜杠连写归一成一个、大小写不敏感），只是按行给出位置，
 * 供提交闸报「文件名:行号」而不泄露名单里的词。
 */
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { DASHBOARD_HOME } = require('./resolveProject.cjs');

const BINARY_EXTENSIONS = new Set(['.png', '.pdf', '.ico', '.exe', '.docx']);
const FORBIDDEN_FILE = path.join(DASHBOARD_HOME, 'opensource-forbidden.txt');
const TEXT_ALLOWLIST = new Map([
  // 本仓的公开 clone 地址保留；只放行地址本身，README 的其它内容仍扫描。
  ['README.md', ['https://github.com/TPP2002/project-dashboard.git']],
]);

function readForbiddenTokens(file = FORBIDDEN_FILE) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    return text.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    // 名单为可选的本机数据；读取或解码失败统一返回空名单。
    return [];
  }
}

const SHARE_LIST_SEGMENTS = ['private', 'opensource-forbidden.txt'];

/** 逐字去重、保留首次出现顺序：词集比较与条数统计都以它为准。 */
function dedupeTokens(tokens) {
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

function sameTokenSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((token) => rightSet.has(token));
}

/**
 * 名单从哪来、是不是必需(卡 DASH-NOLOCAL-LIST-HOST-ONLY-SPARE-FALSE-GREEN-1113)。
 * 不在调度台下:只读本机名单,行为与 readForbiddenTokens() 相同。
 * 在调度台下(SCHED_PERMIT 非空):名单必需;共享盘那份必须有,本机那份也有时两份词集必须一致。
 */
function resolveForbiddenList({ env = process.env, homeFile = FORBIDDEN_FILE } = {}) {
  const vars = env && typeof env === 'object' ? env : {};
  const homeTokens = dedupeTokens(readForbiddenTokens(homeFile));
  const permit = typeof vars.SCHED_PERMIT === 'string' ? vars.SCHED_PERMIT.trim() : '';
  if (!permit) {
    return {
      tokens: homeTokens,
      required: false,
      problem: null,
      homeCount: homeTokens.length,
      shareCount: 0,
      shareFile: null,
    };
  }
  // 副机没有主机的看板数据目录，只能读调度台给的共享盘；共享盘根缺失等同于名单缺失。
  const shareRoot = typeof vars.SCHED_SHARE === 'string' ? vars.SCHED_SHARE.trim() : '';
  const shareFile = shareRoot ? path.join(shareRoot, ...SHARE_LIST_SEGMENTS) : null;
  const shareTokens = shareFile ? dedupeTokens(readForbiddenTokens(shareFile)) : [];
  const tokens = [...homeTokens];
  for (const token of shareTokens) {
    if (!homeTokens.includes(token)) tokens.push(token);
  }
  let problem = null;
  if (shareTokens.length === 0) problem = 'share-list-missing';
  else if (homeTokens.length > 0 && !sameTokenSet(homeTokens, shareTokens)) problem = 'lists-differ';
  return {
    tokens,
    required: true,
    problem,
    homeCount: homeTokens.length,
    shareCount: shareTokens.length,
    shareFile,
  };
}

/** 纯扫描：输入 { file, content } 数组，返回「文件: 标识」，不读盘、不依赖名单。 */
function findViolations(tokens, files) {
  const violations = [];
  for (let { file, content } of files) {
    for (const allowed of TEXT_ALLOWLIST.get(file) || []) content = content.replaceAll(allowed, '');
    // 同时识别源码/JSON 中的反斜杠转义，不让同一路径换个写法就绕过断言。
    const normalized = content.replace(/\\+/g, '\\').toLowerCase();
    for (const identifier of tokens) {
      if (normalized.includes(identifier.toLowerCase())) violations.push(`${file}: ${identifier}`);
    }
  }
  return violations;
}

/** 与 findViolations 同口径，但按行给位置：line 从 1 起，tokenIndex 是 tokens 里从 1 起的序号。 */
function findTokenHits(tokens, files) {
  const hits = [];
  for (let { file, content } of files) {
    for (const allowed of TEXT_ALLOWLIST.get(file) || []) content = content.replaceAll(allowed, '');
    const normalized = content.replace(/\\+/g, '\\').toLowerCase();
    for (const [index, line] of normalized.split(/\r?\n/).entries()) {
      for (const [tokenIndex, identifier] of tokens.entries()) {
        if (line.includes(identifier.toLowerCase())) {
          hits.push({ file, line: index + 1, tokenIndex: tokenIndex + 1 });
        }
      }
    }
  }
  return hits;
}

// 来自被跟踪文本的占位符清点；相似名字的示例也单列，不能用模糊前缀放行。
const PATH_PLACEHOLDERS = [
  'c:/path/to', 'c:/users/demo', 'c:/users/t', 'c:/users/someone', 'c:/users/你的用户名',
  'c:/正斜杠/绝对', 'd:/work', 'd:/code', 'd:/unrelated',
  'f:/code-repo', 'f:/board-repo', 'f:/app-repo', 'f:/app-repo-evil', 'f:/quest-repo',
  'f:/legacy-repo', 'f:/quant-repo', 'f:/shop-repo', 'f:/myapp', 'f:/docs-site', 'f:/projects',
];

// 这四条标准 Windows 浏览器安装路径不含个人、账号或项目信息，因此仅按完整路径放行，禁止扩大为安装目录前缀。
const STANDARD_WINDOWS_SOFTWARE_PATHS = new Set([
  'c:/program files/google/chrome/application/chrome.exe',
  'c:/program files (x86)/google/chrome/application/chrome.exe',
  'c:/program files (x86)/microsoft/edge/application/msedge.exe',
  'c:/program files/microsoft/edge/application/msedge.exe',
]);

/** 纯扫描：输入 { file, content } 数组，返回「文件:行号: 路径」，不读盘、不依赖名单。 */
function findBadPaths(files) {
  const violations = [];
  for (const { file, content } of files) {
    for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
      // 源码/JSON 的多重反斜杠先归一化；词边界排除 URL、STDOUT 和 ref 的末字母。
      const line = rawLine.replace(/\\+/g, '\\');
      for (const match of line.matchAll(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+/g)) {
        const tail = line.slice(match.index + match[0].length);
        const quote = line[match.index - 1];
        // 紧挨引号的路径保留空格和括号；其余按文档/注释中的词及标点边界取路径。
        const end = quote && ['"', "'", '`'].includes(quote) ? tail.indexOf(quote) : -1;
        const segment = end >= 0 ? tail.slice(0, end) : tail.split(/[\s"'`<>|,;:()[\]{}，。、；：（）]/)[0];
        const hit = match[0] + segment;
        // 裸盘符没有有效段；孤立的单字符控制转义是假路径，不跳过正常 n/r/t 开头目录。
        if (!segment || /^[A-Za-z]:\\[nrtbfv0]$/.test(hit)) continue;
        const normalized = hit.replace(/\\/g, '/').toLowerCase();
        const allowed = STANDARD_WINDOWS_SOFTWARE_PATHS.has(normalized)
          || PATH_PLACEHOLDERS.some((prefix) => normalized === prefix || normalized.startsWith(prefix + '/'));
        if (!allowed) violations.push(`${file}:${index + 1}: ${hit}`);
      }
    }
  }
  return violations;
}

module.exports = {
  BINARY_EXTENSIONS,
  TEXT_ALLOWLIST,
  SHARE_LIST_SEGMENTS,
  readForbiddenTokens,
  resolveForbiddenList,
  findViolations,
  findTokenHits,
  PATH_PLACEHOLDERS,
  STANDARD_WINDOWS_SOFTWARE_PATHS,
  findBadPaths,
};
