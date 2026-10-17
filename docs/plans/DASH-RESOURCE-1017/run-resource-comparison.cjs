'use strict';
// Execute only through the controller's sched exec permit. Four sequential fresh processes (ABBA).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const sha = data => createHash('sha256').update(data).digest('hex');

function fixture(dir, seed = 1017) {
  let state = seed >>> 0;
  const randomText = length => {
    let value = '';
    for (let i = 0; i < length; i++) { state = (1664525 * state + 1013904223) >>> 0; value += String.fromCharCode(97 + state % 26); }
    return value;
  };
  const boards = [], files = [];
  function save(relative, data) {
    const file = path.join(dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = JSON.stringify(data); fs.writeFileSync(file, raw); files.push({ path: relative, bytes: Buffer.byteLength(raw), sha256: sha(raw) });
  }
  for (let i = 0; i < 80; i++) {
    const home = `flow-${String(i).padStart(3, '0')}`, board = home + '/board.json'; boards.push(board);
    save(board, { project: { id: home }, tasks: [{ id: home, status: '施工中' }], activity: [{ ts: '2026-10-17T00:00:00Z', text: randomText(256) }] });
    for (let month = 1; month <= 2; month++) save(`${home}/activity-20260${month}.json`, Array.from({ length: 128 }, (_, seq) =>
      ({ ts: `2026-0${month}-01T00:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`, taskId: home, text: randomText(256) })));
  }
  // Enough raw bytes to exercise each independent 16 MiB budget below 50/64 entries.
  const padding = randomText(1024).repeat(1024);
  for (let i = 0; i < 18; i++) {
    const home = `bytes-${String(i).padStart(2, '0')}`, board = home + '/board.json'; boards.push(board);
    save(board, { project: { id: home }, tasks: [], activity: [{ ts: '2026-10-17T00:00:00Z', text: `${i}:${padding}` }] });
    save(home + '/activity-202601.json', [{ ts: '2026-01-01T00:00:00Z', text: `${i}:${padding}` }]);
  }
  const manifest = { seed, queueTransitions: 120, queueWidth: 8, boards, files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
function verifyFixture(dir, manifest) {
  for (const file of manifest.files) assert.equal(sha(fs.readFileSync(path.join(dir, file.path))), file.sha256, 'fixture changed: ' + file.path);
}
function sourceHashes() {
  return Object.fromEntries([
    'web/src/stores/sched.ts', 'web/src/stores/schedResourceLifecycle.ts', 'web/src/components/sched/QueueTable.vue',
    'web/src/api/sched.ts', 'server/server.cjs', 'core/boardReadCache.cjs',
    'web/tests/schedResourceLifecycle.check.mts', 'docs/plans/DASH-RESOURCE-1017/server-fixture.cjs',
    'docs/plans/DASH-RESOURCE-1017/resource-worker.mts', 'docs/plans/DASH-RESOURCE-1017/run-resource-comparison.cjs',
    'docs/plans/DASH-RESOURCE-1017/original-sched.ts', 'docs/plans/DASH-RESOURCE-1017/original-server.cjs',
  ].map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
}
function run() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'native worker requires Node 24 or newer');
  assert.ok(process.env.SCHED_PERMIT, 'controller must obtain a sched exec permit before running this experiment');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-resource-ab-'));
  const initialSources = sourceHashes(), manifest = fixture(dir), runs = [];
  const report = { status: 'running', seed: manifest.seed, order: ['old', 'new', 'new', 'old'], sourceHashes: initialSources,
    fixtureManifestSha256: sha(fs.readFileSync(path.join(dir, 'manifest.json'))), fixtureBytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    fixtureFiles: manifest.files.length, runs, fixtureRoot: dir, productionDataAccessed: false,
    notes: ['Counters/raw-byte weights are distinct from heapUsed, external and RSS.', 'All children share immutable input bytes, seed and process flags; each mode uses a fresh process.', 'This is a controlled pressure experiment, not proof of the production RSS cause.'] };
  try {
    for (const [index, mode] of report.order.entries()) {
      verifyFixture(dir, manifest); assert.deepEqual(sourceHashes(), initialSources, 'source changed during experiment');
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'resource-worker.mts'), '--mode', mode, '--fixture', dir], {
        cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      });
      const label = `resource-${index + 1}-${mode}`;
      fs.writeFileSync(path.join(__dirname, label + '.stdout.json'), child.stdout || '');
      fs.writeFileSync(path.join(__dirname, label + '.stderr.log'), (child.stderr || '') + (child.error ? '\n' + child.error.stack : ''));
      assert.equal(child.status, 0, `worker failed: ${label}; retain raw output and fixture ${dir}`);
      runs.push(JSON.parse(child.stdout));
    }
    verifyFixture(dir, manifest); assert.deepEqual(sourceHashes(), initialSources);
    assert.equal(new Set(runs.map(r => r.responseSha256)).size, 1, 'old/new complete board/summary results must agree');
    report.status = 'measured-controller-review-required';
    fs.writeFileSync(path.join(__dirname, 'resource-comparison.json'), JSON.stringify(report, null, 2) + '\n');
    const resolved = path.resolve(dir), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('dash-resource-ab-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
    console.log(JSON.stringify({ status: report.status, order: report.order, rawRuns: runs.length, report: 'docs/plans/DASH-RESOURCE-1017/resource-comparison.json' }));
  } catch (error) {
    report.status = 'failed-retained-raw-evidence'; report.failure = String(error);
    fs.writeFileSync(path.join(__dirname, 'resource-comparison.json'), JSON.stringify(report, null, 2) + '\n');
    throw error;
  }
}
if (require.main === module) run();
