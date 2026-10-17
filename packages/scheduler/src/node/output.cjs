'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { contained } = require('./objects.cjs');
// The original remote log is one stream. Keep stdout and stderr in a stable
// append-only journal so successive immutable versions preserve offsets.
async function journal(entry) {
  if (entry.journaling) return entry.journaling;
  const work = (async () => {
    entry.logOffsets ??= { stdout: 0, stderr: 0 };
    const destination = path.join(entry.directory, 'combined.log');
    const output = await fs.open(destination, 'a');
    try {
      for (const name of ['stdout', 'stderr']) {
        let input;
        try {
          input = await fs.open(await contained(entry.directory, `workload.${name}.log`), 'r');
          const end = (await input.stat()).size;
          if (end < entry.logOffsets[name]) throw new Error('LOG_TRUNCATED');
          const buffer = Buffer.alloc(65536);
          while (entry.logOffsets[name] < end) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, end - entry.logOffsets[name]), entry.logOffsets[name]);
            if (!bytesRead) throw new Error('LOG_CHANGED');
            await output.writeFile(buffer.subarray(0, bytesRead)); entry.logOffsets[name] += bytesRead;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { await input?.close(); }
      }
      await output.sync();
    } finally { await output.close(); }
    return 'combined.log';
  })();
  entry.journaling = work;
  try { return await work; } finally { entry.journaling = null; }
}
async function artifacts(reader, ticket, attemptId, projectRoot) {
  const objects = (await reader.read([{ kind: 'artifact-manifest', ticketId: ticket.ticketId, attemptId },
    { kind: 'artifact-zip', ticketId: ticket.ticketId, attemptId }])).objects;
  const manifest = objects.find(x => x.entry.kind === 'artifact-manifest')?.value;
  if (!manifest) return { state: 'unavailable', reason: 'artifact manifest not ready' };
  const destination = path.join(projectRoot, '.sched-artifacts', ticket.ticketId);
  await fs.mkdir(destination, { recursive: true }); await contained(projectRoot, path.relative(projectRoot, destination));
  const archive = objects.find(x => x.entry.kind === 'artifact-zip');
  if (manifest.zip) {
    if (!archive || !Buffer.isBuffer(archive.value) || archive.value.length !== manifest.zipBytes) throw new Error('ARTIFACT_ZIP_NOT_READY');
    // Original extractor checks names, central directory, sizes, CRC and links.
    const { Worker } = require('node:worker_threads');
    await new Promise((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        try { parentPort.postMessage({value:require(workerData.module).extractArtifactZip(Buffer.from(workerData.bytes),workerData.destination)}); }
        catch(error) { parentPort.postMessage({error:error.message}); }`, { eval: true, execArgv: [],
        workerData: { module: require.resolve('../sched/client/sched.cjs'), bytes: archive.value, destination } });
      let replied = false;
      worker.once('error', reject); worker.once('message', reply => { replied = true; reply.error ? reject(new Error(reply.error)) : resolve(reply.value); });
      worker.once('exit', code => { if (!replied) reject(new Error(`ARTIFACT_WORKER_EXIT:${code}`)); });
    });
  }
  const file = path.join(destination, `${attemptId}.manifest.json`);
  await fs.writeFile(file, JSON.stringify(manifest));
  await require('../sched/client/sched.cjs').ensureInfoExclude(projectRoot);
  return { state: 'ready', directory: destination };
}
async function followLog(reader, ticketId, attemptId, directory) {
  const entries = (await reader.read([{ kind: 'log-descriptor', ticketId, attemptId }])).objects;
  const descriptor = entries.find(x => x.entry.kind === 'log-descriptor')?.value;
  if (!descriptor) return;
  if (descriptor.nextPageToken !== null) throw new Error('LOG_DIRECTORY_INCOMPLETE');
  await fs.mkdir(directory, { recursive: true });
  const stage = path.join(directory, `.log-${randomUUID()}`), fd = await fs.open(stage, 'wx');
  let size = 0;
  try {
    for (const segment of descriptor.segments) {
      const selected = (await reader.read([{ kind: 'log-segment', ticketId, attemptId, segmentId: segment.segmentId }])).objects;
      const part = selected.find(x => x.entry.kind === 'log-segment' && x.entry.segmentId === segment.segmentId);
      if (!part || !Buffer.isBuffer(part.value) || part.entry.object.hash !== segment.object.hash
        || part.value.length !== segment.object.size || createHash('sha256').update(part.value).digest('hex') !== segment.object.hash) throw new Error('LOG_VERSION_CHANGED');
      size += part.value.length; await fd.writeFile(part.value);
    }
    if (size !== descriptor.totalBytes) throw new Error('LOG_LENGTH');
    await fd.sync(); await fd.close();
    const file = path.join(directory, 'workload.stdout.log');
    let previous;
    try { previous = await fs.readFile(await contained(directory, 'workload.stdout.log')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      const input = await fs.open(stage, 'r');
      try { const prefix = Buffer.alloc(previous.length); const result = await input.read(prefix, 0, prefix.length, 0);
        if (result.bytesRead !== previous.length || !prefix.equals(previous)) throw new Error('LOG_PREFIX_CHANGED'); }
      finally { await input.close(); }
    }
    await fs.rename(stage, file);
  } catch (error) { await fd.close().catch(() => {}); await fs.unlink(stage).catch(() => {}); throw error; }
}
async function appendRemote(run, attemptId, source, destination, quota) {
  run.remoteOffsets ??= {};
  const offset = run.remoteOffsets[attemptId] ?? 0;
  let input;
  try { input = await fs.open(await contained(source, 'workload.stdout.log'), 'r'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await fs.mkdir(destination, { recursive: true });
  const output = await fs.open(path.join(destination, 'workload.stdout.log'), 'a');
  try {
    const size = (await input.stat()).size, current = (await output.stat()).size;
    if (size < offset || current + size - offset > quota) throw new Error('REMOTE_LOG_QUOTA_OR_TRUNCATION');
    let position = offset; const buffer = Buffer.alloc(65536);
    while (position < size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error('LOG_CHANGED');
      await output.writeFile(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    await output.sync(); run.remoteOffsets[attemptId] = position;
  } finally { await input.close(); await output.close(); }
}
module.exports = { journal, artifacts, followLog, appendRemote };
