'use strict';
const s = require('./schema.cjs');
const { fail } = require('./json.cjs');
const caseIdentity = s.fields({ file: (v, p) => {
  s.text(1024)(v, p);
  if (v.includes('\\') || v.includes('..') || v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.split('/').some(x => !x || x === '.')) fail('CASE_PATH', p);
}, titlePath: s.list(s.text(1024), 1, 64), instanceIndex: s.count });
const rerunPlan = s.fields({ complete: s.bool, eligible: s.list(s.fields({ identity: caseIdentity, sourceSha256: s.hash, overlapMs: s.finite() }), 0, 1024),
  slowTimeouts: s.count, otherTimeouts: s.count, retainedFailures: s.count, sharedHookTimeouts: s.count, notes: s.list(s.text(4096), 0, 128) });
const jobResult = (v, p) => {
  s.fields({ ok: s.bool }, { exitCode: s.nullable(s.integer(-2147483648, 2147483647)), reason: s.text(),
    notStarted: s.fields({ attemptId: s.attemptId, state: s.enumeration(['granted']), waitedMs: s.count }),
    refused: s.pattern(/^[a-z][a-z0-9-]{0,63}$/), rerunPlan, logFile: s.text(1024), machine: s.segment,
    command: s.text(4096), finishedAt: s.iso,
    elapsedSec: s.count, rawElapsedSec: s.finite(), suspendedMs: s.finite(), comparable: s.bool,
    suspensionObject: s.fields({ objectId: s.id, hash: s.hash, size: s.count }),
    artifacts: s.fields({ state: s.enumeration(['none', 'zipped', 'listed', 'failed']) }, {
      manifest: s.pattern(/^tk-[0-9a-f]{20}--a[1-9]\d*\.json$/), zip: s.pattern(/^tk-[0-9a-f]{20}--a[1-9]\d*\.zip$/),
      zipBytes: s.count, totalBytes: s.count, fileCount: s.count, detail: s.text(),
    }),
    ciDuringJob: s.fields({ maxWorkers: s.count, firstSeenAt: s.iso, lastSeenAt: s.iso, seenSamples: s.count, samples: s.count }),
  })(v, p);
  if (v.notStarted && (v.ok !== false || v.exitCode !== null || v.refused !== undefined || v.rerunPlan !== undefined)) fail('NOT_STARTED_RESULT', p);
  if (v.refused !== undefined && (v.ok !== false || v.exitCode !== 2)) fail('REFUSED_RESULT', p);
  // command/logFile are observations only. Neither field is an execution/read path capability.
};
module.exports = { jobResult, validateJobResult: input => s.validate(jobResult, input) };
