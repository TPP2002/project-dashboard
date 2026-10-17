'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createRemoteClient } = require('./remote.cjs');
const p = require('../../protocol/contract.cjs');
const old = () => require('./sched.cjs');
const terminal = t => ['passed', 'failed', 'cancelled', 'voided'].includes(t.state);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const isRemote = options => {
  const mode = options?.mode ?? options?.env?.SCHED_MODE ?? process.env.SCHED_MODE ?? 'local';
  if (!['local', 'remote'].includes(mode)) throw new Error('SCHED_MODE_INVALID');
  return mode === 'remote';
};
function configuration(options = {}) {
  if (options.remoteConfig) return options.remoteConfig;
  const file = (options.env ?? process.env).SCHED_REMOTE_CONFIG;
  if (!file || !path.isAbsolute(file)) throw new Error('REMOTE_CONFIG_REQUIRED');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function connect(options = {}) {
  const port = options.remotePort ?? require('../../gateway/client.cjs').createSemanticClient(configuration(options));
  return { client: createRemoteClient({ port, timeoutMs: options.receiptTimeoutMs ?? options.timeoutMs ?? 30000 }),
    close: () => { if (!options.remotePort) port.close?.(); } };
}
async function using(options, fn) {
  const c = connect(options);
  try { return await fn(c.client); }
  catch (error) {
    if (error.message === 'WAIT_TIMEOUT') { error.message = '等待超时'; error.exitCode = 4; }
    else if (error.message === 'BUSINESS_ACCEPTANCE_UNKNOWN' || error.code === 'TIMEOUT') error.exitCode = 4;
    else if (/REMOTE_DISCONNECTED|EXECUTION_UNKNOWN|READ_FENCED|READ_UNAVAILABLE/.test(error.message)
      || ['DISCONNECTED', 'FENCED', 'IO_FAILURE'].includes(error.code)) error.exitCode = 3;
    throw error;
  } finally { c.close(); }
}
async function usageCorrection(client, options) {
  const api = old(); let cores = Number(options.cores), usageKey, original;
  const history = await client.read([{ kind: 'hub-switch' }, { kind: 'scheduler-format' }, { kind: 'usage-history', project: options.project }]);
  const hub = history.objects.find(x => x.entry.kind === 'hub-switch')?.value;
  const usage = history.objects.find(x => x.entry.kind === 'usage-history')?.value;
  const format = history.objects.find(x => x.entry.kind === 'scheduler-format')?.value;
  if (hub?.coresHistoryCorrect === true && format?.capabilities.includes('usage-history-v1')) {
    usageKey = api.usageKeyFor({ project: options.project, workType: options.workType ?? 'other', command: options.command, args: options.args });
    const peaks = (usage?.groups?.[usageKey] ?? []).slice(-10).filter(x => Number.isFinite(x.peakCores)).map(x => x.peakCores);
    const suggestion = api.suggestCores({ requested: cores, peaks, strict: options.coresStrict || options.resident, label: options.workType ?? 'other' });
    if (suggestion.changed) { original = cores; cores = suggestion.cores; (options.notice ?? console.error)(suggestion.reason); }
  }
  return { requestedCores: cores, ...(usageKey ? { usageKey } : {}), ...(original ? { requestedCoresOriginal: original } : {}) };
}
function syncRead(action, id, options = {}) {
  const config = configuration(options);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'remote-sync.cjs')], {
    input: JSON.stringify({ action, id, config, catalog: require('./deployment-config.cjs').getDeploymentConfig() }),
    encoding: 'utf8', timeout: Math.min(options.timeoutMs ?? 15000, 60000),
    maxBuffer: Math.min(config.maxObjectBytes ?? 16 * 1024 * 1024, 64 * 1024 * 1024), windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NODE_OPTIONS$|^NODE_PATH$/i.test(k))),
  });
  if (result.error || result.status !== 0) throw new Error(`REMOTE_READ_UNKNOWN:${result.error?.message ?? result.stderr}`);
  const reply = JSON.parse(result.stdout);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
async function submit(options) {
  return using(options, async client => {
    const api = old(), root = path.resolve(options.root ?? process.cwd());
    let request = options.request;
    if (!request) {
      const key = options.key ?? api.autoIdempotencyKey({ now: () => new Date().toISOString(), nonce: randomUUID }, options.project);
      const prior = await client.ticket(api.deriveTicketId(options.project, key));
      let codeRef = options.codeRef ?? api.autoCodeRef(root);
      codeRef = codeRef === 'content:auto' ? api.contentFingerprint(root, options.targets ?? ['.'])
        : typeof codeRef === 'string' ? { kind: 'commit', value: codeRef.replace(/^commit:/, '') } : codeRef;
      const correction = await usageCorrection(client, options);
      request = { idempotencyKey: key, project: options.project, submitter: options.submitter ?? os.hostname(),
        category: options.category ?? 'other', title: options.title, work: { type: options.workType ?? 'other', targetPaths: options.targets ?? ['.'] },
        ...correction, allowedMachines: options.machines ?? [os.hostname()], codeRef, resources: { exclusive: options.exclusive ?? [] },
        createdAt: options.createdAt ?? prior?.request.createdAt ?? new Date().toISOString(),
        ...(options.parent ? { parentTicketId: options.parent } : {}), ...(options.engine ? { engine: options.engine } : {}),
        ...(options.resident ? { resident: true } : {}) };
    }
    api.assertCategoryMatchesWorkType(request.category, request.work.type);
    const result = await client.submit(request, request.idempotencyKey, { cwd: root });
    const accepted = result.status === 'business_accepted';
    return { ticketId: api.deriveTicketId(request.project, request.idempotencyKey), idempotencyKey: request.idempotencyKey,
      contentHash: p.contentHash(request), status: accepted ? 'accepted' : 'rejected', exitCode: accepted ? 0 : 2,
      ...(!accepted ? { reason: result.reason } : {}) };
  });
}
async function waitFor(id, options) {
  return using(options, async client => {
    const ticket = await client.wait(id, { until: options.until ?? 'granted', timeoutMs: options.timeoutMs ?? Infinity, signal: options.signal });
    return { ticket, exitCode: ticket.state === 'failed' ? 1 : ['cancelled', 'voided'].includes(ticket.state) ? 5 : 0 };
  });
}
async function command(kind, id, options = {}) {
  return using(options, async client => {
    const data = kind === 'finish' ? { ticketId: id, result: options.result, ...(options.reason ? { reason: options.reason } : {}) }
      : kind === 'cancel' ? { ticketId: id, ...(options.reason ? { reason: options.reason } : {}) } : options.data;
    const commandId = options.commandId ?? `${kind}-${randomUUID()}`;
    const result = await client.command(kind, data, { commandId, submitter: options.submitter ?? os.hostname(),
      expiresAt: new Date(Date.now() + 600000).toISOString() });
    return { commandId, status: result.status === 'business_accepted' ? 'executed' : 'rejected',
      at: new Date().toISOString(), ...(result.reason ? { reason: result.reason } : {}), exitCode: result.status === 'business_accepted' ? 0 : 2 };
  });
}
async function run(id, options = {}) {
  return using(options, async client => {
    const ticket = await client.ticket(id);
    if (!ticket) throw new Error('TICKET_NOT_FOUND');
    if (ticket.registerOnly) return { ticketId: id, result: ticket.state, exitCode: 0 };
    const submission = { stage: 'submission', ticketId: id, project: ticket.request.project, submissionHash: ticket.contentHash };
    const request = { kind: 'local-run', callId: options.callId ?? `run-${id}-${p.contentHash([options.command, options.args ?? [], path.resolve(options.root ?? process.cwd())]).slice(0, 24)}`,
      submission, command: options.command, args: options.args ?? [], cwd: path.resolve(options.root ?? process.cwd()),
      env: Object.fromEntries(Object.entries(options.env ?? process.env).filter(([, value]) => typeof value === 'string')) };
    let reply, stdoutOffset = 0, stderrOffset = 0, cancellation;
    // Retry the same immutable local request. Transport failure is never a new callId.
    for (let retry = 0; retry < 3; retry++) {
      try { reply = await client.execute(request); break; }
      catch (error) { if (retry === 2) throw error; await pause(250); }
    }
    const cancel = () => { cancellation ??= client.execute({ kind: 'local-run-cancel', callId: randomUUID(), runId: reply.runId }); cancellation.catch(() => {}); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      while (true) {
        if (reply.stdout.offset !== stdoutOffset || reply.stderr.offset !== stderrOffset) throw new Error('OUTPUT_OFFSET');
        (options.remoteOutput ?? (bytes => process.stdout.write(bytes)))(Buffer.from(reply.stdout.bytesBase64, 'base64'));
        (options.remoteError ?? (bytes => process.stderr.write(bytes)))(Buffer.from(reply.stderr.bytesBase64, 'base64'));
        const progressed = reply.stdout.nextOffset !== stdoutOffset || reply.stderr.nextOffset !== stderrOffset;
        stdoutOffset = reply.stdout.nextOffset; stderrOffset = reply.stderr.nextOffset;
        if (reply.state === 'unknown') throw new Error(`EXECUTION_UNKNOWN:${reply.reason ?? reply.runId}`);
        if (reply.state === 'terminal' && !progressed) return { ticketId: id, result: reply.terminal.ok ? 'passed' : 'failed',
          exitCode: reply.terminal.exitCode, jobResult: reply.terminal, ...(reply.reason ? { reason: reply.reason } : {}) };
        reply = await client.execute({ kind: 'local-run-read', callId: randomUUID(), runId: reply.runId,
          stdoutOffset, stderrOffset, maxBytes: 65536, waitMs: 1000 });
      }
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); if (cancellation) await cancellation; }
  });
}
async function exec(options) {
  const api = old(), root = options.root ?? process.cwd();
  const resolved = api.resolveWindowsExecutable(options.command, options.args ?? [], { cwd: root, env: options.env ?? process.env });
  if (!resolved.ok) return { exitCode: 2, reason: resolved.reason, suggestion: resolved.suggestion };
  const category = options.category ?? 'other', workType = options.workType ?? 'other';
  const testArgs = api.vitestSubcommand(options.command, options.args ?? []);
  if (testArgs && category !== 'unit-test' && !(testArgs[0] === 'bench' && category === 'perf-bench')) throw new Error('CATEGORY_MISMATCH');
  const ctx = { share: undefined, env: options.env ?? process.env, notice: options.notice ?? (text => process.stderr.write(text + '\n')) };
  let auto;
  await using(options, async client => {
    ctx.remoteRead = async selector => (await client.read([selector])).objects[0]?.value ?? null;
    auto = await api.decideAuto(ctx, options, root, category, workType);
  });
  const key = options.key ?? api.autoIdempotencyKey({ now: () => new Date().toISOString(), nonce: randomUUID }, options.project);
  let request;
  let prior, correction;
  if (auto) await using(options, async client => {
    prior = await client.ticket(api.deriveTicketId(auto.project, key));
    correction = await usageCorrection(client, { ...options, project: auto.project, workType: auto.classified.item });
  });
  if (auto) request = { idempotencyKey: key, project: auto.project, submitter: options.submitter ?? os.hostname(), category,
    title: options.title, work: { type: auto.classified.item, targetPaths: options.targets ?? ['.'] }, ...correction,
    allowedMachines: auto.machines, codeRef: { kind: 'commit', value: auto.head }, resources: { exclusive: [] }, createdAt: prior?.request.createdAt ?? new Date().toISOString(),
    execution: 'auto', origin: os.hostname(), menu: { item: auto.classified.item, args: [...auto.classified.args] },
    ...(options.parent ? { parentTicketId: options.parent } : {}), ...(options.engine ? { engine: options.engine } : {}) };
  options._summaryTicket?.(api.deriveTicketId(options.project, key));
  const receipt = await submit({ ...options, key, ...(request ? { request } : {}) });
  if (receipt.exitCode) return receipt;
  options._summaryAccepted?.(receipt.ticketId);
  let queuePosition = null;
  try {
  await using(options, async client => {
    const heartbeat = (await client.read([{ kind: 'dispatcher-heartbeat' }])).objects[0]?.value;
    queuePosition = heartbeat?.queue?.find(x => x.ticketId === receipt.ticketId)?.position ?? null;
  });
  } catch { /* Queue position is informational, never an admission decision. */ }
  (options.output ?? console.log)(JSON.stringify({ ticketId: receipt.ticketId, queuePosition }));
  return run(receipt.ticketId, options);
}
async function hold(options) {
  const receipt = await submit({ ...options, resident: true, category: options.category ?? 'other' });
  if (receipt.exitCode) return receipt;
  return using(options, async client => {
    const ticket = await client.wait(receipt.ticketId, { timeoutMs: options.timeoutMs ?? Infinity });
    if (terminal(ticket)) return { ticketId: ticket.ticketId, result: ticket.state, exitCode: ticket.state === 'passed' ? 0 : 1 };
    const permit = ticket.attempts.find(a => a.attemptId === ticket.currentAttemptId)?.permit;
    if (!ticket.request.resident || !permit?.resident || permit.machine !== os.hostname()) throw new Error('RESIDENT_PERMIT');
    const renew = () => client.renewResident({ ticketId: ticket.ticketId, attemptId: permit.attemptId, permitToken: permit.token, cores: permit.grantedCores });
    await renew();
    // The CLI owns only the child it starts here. Existing services are never adopted into a JobObject.
    const child = spawn(options.command, options.args ?? [], { cwd: options.root ?? process.cwd(), windowsHide: true, shell: false, stdio: 'inherit',
      env: { ...(options.env ?? process.env), SCHED_MODE: 'remote', SCHED_PERMIT: `${ticket.ticketId}:${permit.attemptId}:${permit.token}`, SCHED_GRANTED_CORES: String(permit.grantedCores) } });
    const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let renewing = false;
    const timer = setInterval(() => { if (!renewing) { renewing = true; renew().catch(error => {
      (options.notice ?? console.error)(`常驻占用续约未知:${error.message}`);
    }).finally(() => { renewing = false; }); } }, (options.beatSec ?? 30) * 1000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      await client.cancel(ticket.ticketId, { submitter: options.submitter ?? os.hostname(), reason: `resident child exited:${code}` });
      return { ticketId: ticket.ticketId, result: 'cancelled', exitCode: code };
    } finally { clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  });
}
module.exports = { isRemote, configuration, connect, syncRead, submit, waitFor, command, run, exec, hold };
