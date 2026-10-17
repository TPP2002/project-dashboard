'use strict';
const s = require('./schema.cjs');
const b = require('./business.cjs');
const { fail } = require('./json.cjs');
const { selector, localRead } = require('./read-manifest.cjs');
const semantic = (v, p) => {
  s.enumeration(['submit', 'command', 'read', 'read-object', 'wait', 'resident-renew'])(v?.kind, `${p}.kind`);
  if (v.kind === 'read-object') return localRead(v, p);
  const bodies = {
    submit: { request: b.submission }, command: { command: b.command },
    read: { selectors: s.list(selector, 1, 32, true), snapshotId: s.nullable(s.id), pageToken: s.nullable(s.id) },
    wait: { ticketId: s.ticketId, afterSeq: s.count },
    'resident-renew': { ticketId: s.ticketId, attemptId: s.attemptId, permitToken: s.text(256), cores: s.positive },
  };
  if (!bodies[v.kind]) fail('LOCAL_KIND', p);
  s.fields({ kind: s.enumeration([v.kind]), callId: s.id, ...bodies[v.kind] })(v, p);
  if (v.kind === 'read' && v.pageToken !== null && v.snapshotId === null) fail('PAGE_SNAPSHOT_REQUIRED', p);
};
module.exports = { validateLocalSemanticRequest: input => s.validate(semantic, input) };
