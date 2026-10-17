'use strict'
/* global setTimeout, clearTimeout */

const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const SNAPSHOT_REF_PREFIX = 'refs/sched/snapshots/'
const SENSITIVE_NAME_PATTERNS = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i, /\.pfx$/i]
const DEFAULT_MAX_FILE_BYTES = 52428800
const DEFAULT_TIMEOUT_MS = 120000
const REASONS = Object.freeze({
  SENSITIVE: 'snapshot-sensitive', NO_HEAD: 'snapshot-no-head', BASE_MISSING: 'snapshot-base-missing',
  MISSING: 'snapshot-missing', BUNDLE_PREREQUISITE_MISSING: 'snapshot-bundle-prerequisite-missing',
  COMMIT_MISMATCH: 'snapshot-commit-mismatch', GIT_FAILED: 'snapshot-git-failed',
  TIMEOUT: 'snapshot-timeout', BAD_TICKET: 'snapshot-bad-ticket',
})
const TICKET_RE = /^tk-[0-9a-f]{20}$/

function validTicket(ticketId) { return typeof ticketId === 'string' && TICKET_RE.test(ticketId) }
function refFor(ticketId) { return `${SNAPSHOT_REF_PREFIX}${ticketId}` }
function indexFor(tempDir, ticketId) { return path.join(tempDir, `sched-snapshot-${ticketId}.index`) }
function elapsed(start) { return Number(process.hrtime.bigint() - start) / 1e6 }
function cleanEnvironment(extra = {}) {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key]
  return { ...env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extra }
}
function tail(stderr) { return stderr.trim().split(/\r?\n/).slice(-5).join('\n') }
function failure(error, step) {
  if (error && error.snapshotTimeout) return { ok: false, reason: REASONS.TIMEOUT, step }
  return { ok: false, reason: REASONS.GIT_FAILED, step, detail: tail(String(error && (error.stderr || error.message) || error)) }
}

/** Wait for a timed-out Git process and all its descendants to terminate. */
async function killTree(child) {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    return
  }
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore', env: cleanEnvironment(),
    })
    killer.once('error', () => { child.kill('SIGKILL'); resolve() })
    killer.once('close', code => { if (code !== 0) child.kill('SIGKILL'); resolve() })
  })
}

function runGit(repoPath, args, { indexPath, timeoutMs = DEFAULT_TIMEOUT_MS, step = 'git', extraEnv, readConfig = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = cleanEnvironment({ ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}), ...extraEnv })
    const prefix = ['-C', repoPath, '-c', 'core.quotepath=false', '-c', 'gc.auto=0']
    if (!readConfig) prefix.push('-c', 'core.splitIndex=false')
    // Test-only process-tree probe; never set by production callers.
    const testStub = process.env.SCHED_SNAPSHOT_TEST_HANG_GIT_STEP === step && process.env.SCHED_SNAPSHOT_TEST_GIT_STUB
    const command = testStub ? process.execPath : 'git'
    const commandArgs = testStub ? [testStub, '--hang-git'] : [...prefix, ...args]
    const child = spawn(command, commandArgs, {
      shell: false, windowsHide: true, detached: process.platform !== 'win32', env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = [], stderr = []
    let timedOut = false, spawnError, killPromise
    const timer = setTimeout(() => { timedOut = true; killPromise = killTree(child) }, timeoutMs)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', error => { spawnError = error })
    child.once('close', async code => {
      clearTimeout(timer)
      if (killPromise) await killPromise
      const output = Buffer.concat(stdout)
      const errorText = Buffer.concat(stderr).toString('utf8')
      if (timedOut) reject(Object.assign(new Error(`git timed out at ${step}`), { snapshotTimeout: true, step, stderr: errorText }))
      else if (spawnError || code !== 0) reject(Object.assign(new Error(`git failed at ${step}: ${code}`), { step, stderr: errorText || String(spawnError || '') }))
      else resolve(output)
    })
  })
}
async function gitText(repoPath, args, options) { return (await runGit(repoPath, args, options)).toString('utf8').trim() }
async function gitExists(repoPath, args, options) {
  try { await runGit(repoPath, args, options); return true }
  catch (error) { if (error.snapshotTimeout) throw error; return false }
}
async function removeIfPresent(file) {
  try { await fs.unlink(file); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function deleteRef(repoPath, ref, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!await gitExists(repoPath, ['show-ref', '--verify', '--quiet', ref], { timeoutMs, step: 'check-ref' })) return false
  await runGit(repoPath, ['update-ref', '-d', ref], { timeoutMs, step: 'delete-ref' })
  return true
}
async function removeIndex(tempDir, ticketId) {
  const file = indexFor(tempDir, ticketId)
  const removed = await removeIfPresent(file)
  await removeIfPresent(`${file}.lock`)
  return removed
}
async function cleanOwnResidue(repoPath, ticketId, tempDir, timeoutMs) {
  await deleteRef(repoPath, refFor(ticketId), timeoutMs)
  await removeIndex(tempDir, ticketId)
}
function checkpoint(step) {
  // Test-only crash hook. The fixture sets this to simulate a killed process.
  if (process.env.SCHED_SNAPSHOT_TEST_KILL_AFTER === step) process.exit(137)
}
async function timedStep(stepMs, name, action) {
  const start = process.hrtime.bigint()
  try { return await action() } finally { stepMs[name] = elapsed(start) }
}
function parseStatus(buffer) {
  const paths = [], contentPaths = []
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue
    const code = record.slice(0, 2), name = record.slice(3)
    paths.push(name)
    if (![' D', 'D ', 'DD', 'AD'].includes(code)) contentPaths.push(name)
  }
  return { paths, contentPaths }
}
async function sensitiveFiles(repoPath, paths, maxFileBytes) {
  const found = []
  for (const name of paths) {
    let info
    try { info = await fs.lstat(path.join(repoPath, name)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const basename = path.basename(name), bytes = info.size
    if (SENSITIVE_NAME_PATTERNS.some(pattern => pattern.test(basename))) found.push({ path: name, why: 'name', bytes })
    else if (bytes > maxFileBytes) found.push({ path: name, why: 'size', bytes })
  }
  return found
}
async function configuredTrue(repoPath, key, timeoutMs) {
  try { return await gitText(repoPath, ['config', '--bool', '--get', key], { timeoutMs, step: `config-${key}`, readConfig: true }) === 'true' }
  catch (error) { if (error.snapshotTimeout) throw error; return false }
}
async function shouldReadTree(repoPath, timeoutMs) {
  for (const key of ['core.splitIndex', 'index.sparse', 'core.sparseCheckout']) {
    if (await configuredTrue(repoPath, key, timeoutMs)) return true
  }
  return false
}

async function createSnapshot({ repoPath, ticketId, tempDir = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  if (!validTicket(ticketId)) return { ok: false, reason: REASONS.BAD_TICKET }
  const started = process.hrtime.bigint(), stepMs = {}, indexPath = indexFor(tempDir, ticketId), ref = refFor(ticketId)
  let step = 'cleanup-residue'
  try {
    await cleanOwnResidue(repoPath, ticketId, tempDir, timeoutMs)
    step = 'head'
    let parent
    try { parent = await gitText(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeoutMs, step }) }
    catch (error) { if (error.snapshotTimeout) throw error; return { ok: false, reason: REASONS.NO_HEAD } }
    step = 'prepare-index'
    await fs.mkdir(tempDir, { recursive: true })
    let method = 'read-tree'
    if (!await shouldReadTree(repoPath, timeoutMs)) {
      const found = await gitText(repoPath, ['rev-parse', '--git-path', 'index'], { timeoutMs, step: 'index-path' })
      const realIndex = path.isAbsolute(found) ? found : path.resolve(repoPath, found)
      try {
        await timedStep(stepMs, 'copy-index', () => fs.copyFile(realIndex, indexPath))
        method = 'copy-index'
        checkpoint('copy-index')
        step = 'inspect-index-flags'
        const flags = await runGit(repoPath, ['ls-files', '-v', '-z'], { indexPath, timeoutMs, step })
        if (flags.toString('utf8').split('\0').some(entry => entry && (entry[0] === 'S' || /[a-z]/.test(entry[0])))) {
          await removeIndex(tempDir, ticketId)
          method = 'read-tree'
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (method === 'read-tree') {
      step = 'read-tree'
      await timedStep(stepMs, step, () => runGit(repoPath, ['read-tree', 'HEAD'], { indexPath, timeoutMs, step }))
    }
    step = 'status'
    const status = await timedStep(stepMs, step, () => runGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { indexPath, timeoutMs, step }))
    checkpoint(step)
    const changed = parseStatus(status)
    step = 'sensitive-check'
    const sensitive = await timedStep(stepMs, step, () => sensitiveFiles(repoPath, changed.contentPaths, maxFileBytes))
    if (sensitive.length) {
      await removeIndex(tempDir, ticketId)
      return { ok: false, reason: REASONS.SENSITIVE, files: sensitive }
    }
    step = 'add'
    await timedStep(stepMs, step, () => runGit(repoPath, ['add', '-A'], { indexPath, timeoutMs, step }))
    checkpoint(step)
    step = 'write-tree'
    const tree = await timedStep(stepMs, step, () => gitText(repoPath, ['write-tree'], { indexPath, timeoutMs, step }))
    checkpoint(step)
    step = 'commit-tree'
    const identity = {
      GIT_AUTHOR_NAME: 'sched-snapshot', GIT_AUTHOR_EMAIL: 'sched-snapshot@localhost',
      GIT_COMMITTER_NAME: 'sched-snapshot', GIT_COMMITTER_EMAIL: 'sched-snapshot@localhost',
    }
    const commit = await timedStep(stepMs, step, () => gitText(repoPath, ['commit-tree', tree, '-p', parent, '-m', `[sched-snapshot] ${ticketId}`], { timeoutMs, step, extraEnv: identity }))
    checkpoint(step)
    step = 'update-ref'
    await timedStep(stepMs, step, () => runGit(repoPath, ['update-ref', ref, commit], { timeoutMs, step }))
    checkpoint(step)
    step = 'index-release'
    await timedStep(stepMs, step, () => removeIndex(tempDir, ticketId))
    return { ok: true, ticketId, ref, commit, tree, parent, method, changedPaths: changed.paths, elapsedMs: elapsed(started), stepMs }
  } catch (error) {
    try { await cleanOwnResidue(repoPath, ticketId, tempDir, timeoutMs) } catch { /* retain original error */ }
    return failure(error, step)
  }
}

async function removeOwnBundleTemps(destDir, ticketId) {
  let entries
  try { entries = await fs.readdir(destDir) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (entry.startsWith(`.${ticketId}.bundle.tmp-`)) await removeIfPresent(path.join(destDir, entry))
  }
}

async function createBundle({ repoPath, ticketId, mainCommit, destDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!validTicket(ticketId)) return { ok: false, reason: REASONS.BAD_TICKET }
  const started = process.hrtime.bigint(), ref = refFor(ticketId)
  let step = 'bundle-residue', temporary
  try {
    await fs.mkdir(destDir, { recursive: true })
    await removeOwnBundleTemps(destDir, ticketId)
    step = 'check-ref'
    if (!await gitExists(repoPath, ['show-ref', '--verify', '--quiet', ref], { timeoutMs, step })) return { ok: false, reason: REASONS.MISSING }
    step = 'check-base'
    if (!await gitExists(repoPath, ['cat-file', '-e', `${mainCommit}^{commit}`], { timeoutMs, step })) {
      await cleanupSnapshot({ repoPath, ticketId })
      return { ok: false, reason: REASONS.BASE_MISSING }
    }
    step = 'merge-base'
    let base
    try { base = await gitText(repoPath, ['merge-base', ref, mainCommit], { timeoutMs, step }) }
    catch (error) {
      if (error.snapshotTimeout) throw error
      await cleanupSnapshot({ repoPath, ticketId })
      return { ok: false, reason: REASONS.BASE_MISSING }
    }
    temporary = path.join(destDir, `.${ticketId}.bundle.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
    step = 'bundle-tmp'
    await runGit(repoPath, ['bundle', 'create', temporary, ref, `^${base}`], { timeoutMs, step })
    checkpoint(step)
    step = 'bundle-rename'
    const bundlePath = path.join(destDir, `${ticketId}.bundle`)
    await fs.rename(temporary, bundlePath)
    temporary = undefined
    const bytes = (await fs.stat(bundlePath)).size
    return { ok: true, bundlePath, base, bytes, elapsedMs: elapsed(started) }
  } catch (error) {
    if (temporary) try { await removeIfPresent(temporary) } catch { /* retain original error */ }
    return failure(error, step)
  }
}

async function cleanupSnapshot({ repoPath, ticketId, tempDir = os.tmpdir() }) {
  if (!validTicket(ticketId)) return { removedRef: false, removedIndex: false }
  const removedRef = await deleteRef(repoPath, refFor(ticketId))
  const removedIndex = await removeIndex(tempDir, ticketId)
  return { removedRef, removedIndex }
}

async function removeBundle({ destDir, ticketId }) {
  if (!validTicket(ticketId)) return false
  return removeIfPresent(path.join(destDir, `${ticketId}.bundle`))
}

async function sweepStaleSnapshots({ repoPath, tempDir = os.tmpdir(), destDir, maxAgeMs = 86_400_000, now = Date.now() }) {
  const current = now instanceof Date ? now.getTime() : now
  const removed = { refs: [], files: [] }
  const listing = (await runGit(repoPath, ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)%00', SNAPSHOT_REF_PREFIX], { step: 'sweep-refs' })).toString('utf8')
  for (const line of listing.split('\n')) {
    const [ref, stamp] = line.split('\0')
    if (!ref || !validTicket(ref.slice(SNAPSHOT_REF_PREFIX.length)) || !/^\d+$/.test(stamp || '')) continue
    if (current - Number(stamp) * 1000 > maxAgeMs && await deleteRef(repoPath, ref)) removed.refs.push(ref)
  }
  for (const directory of [tempDir, destDir].filter(Boolean)) {
    let entries
    try { entries = await fs.readdir(directory) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const entry of entries) {
      if (!/^sched-snapshot-tk-[0-9a-f]{20}\.index(?:\.lock)?$/.test(entry) && !/^\.tk-[0-9a-f]{20}\.bundle\.tmp-[^/\\]+$/.test(entry)) continue
      const file = path.join(directory, entry)
      const info = await fs.stat(file)
      if (current - info.mtimeMs > maxAgeMs && await removeIfPresent(file)) removed.files.push(file)
    }
  }
  return removed
}

async function fetchSnapshot({ mirrorPath, bundlePath, ticketId, expectedCommit, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!validTicket(ticketId)) return { ok: false, reason: REASONS.BAD_TICKET, detail: 'invalid ticket' }
  const ref = refFor(ticketId)
  let step = 'bundle-verify'
  try {
    try { await runGit(mirrorPath, ['bundle', 'verify', bundlePath], { timeoutMs, step }) }
    catch (error) {
      if (error.snapshotTimeout) throw error
      const detail = tail(String(error.stderr || error.message))
      if (/prerequisite|lacks these|missing/i.test(detail)) return { ok: false, reason: REASONS.BUNDLE_PREREQUISITE_MISSING, detail }
      return { ok: false, reason: REASONS.GIT_FAILED, step, detail }
    }
    step = 'fetch'
    await runGit(mirrorPath, ['fetch', '--no-tags', bundlePath, `${ref}:${ref}`], { timeoutMs, step })
    step = 'verify-commit'
    const commit = await gitText(mirrorPath, ['rev-parse', '--verify', `${ref}^{commit}`], { timeoutMs, step })
    if (commit !== expectedCommit) {
      await deleteRef(mirrorPath, ref, timeoutMs)
      return { ok: false, reason: REASONS.COMMIT_MISMATCH, detail: `expected ${expectedCommit}, received ${commit}` }
    }
    const tree = await gitText(mirrorPath, ['rev-parse', '--verify', `${commit}^{tree}`], { timeoutMs, step: 'verify-tree' })
    return { ok: true, commit, tree }
  } catch (error) { return { ...failure(error, step), detail: tail(String(error.stderr || error.message)) } }
}

async function dropFetchedSnapshot({ mirrorPath, ticketId }) {
  if (!validTicket(ticketId)) return false
  return deleteRef(mirrorPath, refFor(ticketId))
}

module.exports = {
  SNAPSHOT_REF_PREFIX, SENSITIVE_NAME_PATTERNS, DEFAULT_MAX_FILE_BYTES, DEFAULT_TIMEOUT_MS, REASONS,
  createSnapshot, createBundle, cleanupSnapshot, removeBundle, sweepStaleSnapshots,
  fetchSnapshot, dropFetchedSnapshot,
}
