'use strict';
const s = require('./schema.cjs');
const { fail, canonicalJson } = require('./json.cjs');
const { identity } = require('./identities.cjs');
const { jobResult } = require('./job-result.cjs');

const LOCAL_EXECUTION_KINDS = Object.freeze(['local-run', 'local-run-read', 'local-run-cancel']);
const localText = (max, min = 1) => (v, p) => {
  s.text(max, min)(v, p);
  if (v.includes('\0')) fail('LOCAL_NUL', p);
};
const cwd = (v, p) => {
  localText(32768)(v, p);
  if (!(/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || /^\\\\[^\\]+\\[^\\]+/.test(v))) fail('LOCAL_CWD', p);
};
const localContext = s.fields({ cwd });
const environment = (v, p) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 1024) fail('LOCAL_ENV', p);
  for (const [key, value] of Object.entries(v)) {
    localText(1024)(key, p);
    if (key.includes('=')) fail('LOCAL_ENV', p);
    localText(32768, 0)(value, `${p}.${key}`);
  }
};
function localExecution(v, p) {
  s.enumeration(LOCAL_EXECUTION_KINDS)(v?.kind, `${p}.kind`);
  const body = v.kind === 'local-run' ? {
    submission: (value, at) => identity(value, at, ['submission']),
    command: localText(32768), args: s.list(localText(32768, 0), 0, 4096), cwd, env: environment,
  } : v.kind === 'local-run-read' ? {
    runId: s.id, stdoutOffset: s.count, stderrOffset: s.count,
    maxBytes: s.integer(1, 65536), waitMs: s.integer(0, 1000),
  } : { runId: s.id };
  s.fields({ kind: s.enumeration([v.kind]), callId: s.id, ...body })(v, p);
  // This is local IPC only, with room for its native transport wrapper.
  if (Buffer.byteLength(canonicalJson(v)) > 256 * 1024) fail('LOCAL_FRAME_LIMIT', p);
}
function output(v, p) {
  s.fields({ offset: s.count, nextOffset: s.count, bytesBase64: s.text(87384, 0) })(v, p);
  const bytes = Buffer.from(v.bytesBase64, 'base64');
  if (bytes.toString('base64') !== v.bytesBase64 || bytes.length !== v.nextOffset - v.offset) fail('LOCAL_OUTPUT_RANGE', p);
}
function executionReply(v, p) {
  s.fields({ kind: s.enumeration(['execution']), runId: s.id,
    state: s.enumeration(['queued', 'running', 'terminal', 'unknown']),
    stdout: output, stderr: output, terminal: s.nullable(jobResult),
  }, { reason: s.text() })(v, p);
  if (v.stdout.nextOffset - v.stdout.offset + v.stderr.nextOffset - v.stderr.offset > 65536) fail('LOCAL_OUTPUT_LIMIT', p);
  if ((v.state === 'terminal') !== (v.terminal !== null)) fail('LOCAL_TERMINAL', p);
  if (v.terminal && (!Object.hasOwn(v.terminal, 'exitCode') || (v.terminal.exitCode === null && v.terminal.ok))) fail('LOCAL_TERMINAL', p);
}
module.exports = { LOCAL_EXECUTION_KINDS, localContext, localExecution,
  validateLocalExecutionReply: input => s.validate(executionReply, input) };
