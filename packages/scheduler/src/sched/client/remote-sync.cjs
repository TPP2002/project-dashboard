'use strict';
// Bounded synchronous facade for old callers. It only performs semantic IPC;
// it cannot inspect an old share or invent a fresh grant from a file timestamp.
const fs = require('node:fs');
const { createRemoteClient } = require('./remote.cjs');
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!['ticket', 'status'].includes(input.action)) throw new Error('SYNC_ACTION');
  // This is the finite child's entrypoint. The parent forwards its already
  // validated administrator catalog; no cloud message or old share supplies it.
  require('./deployment-config.cjs').configureDeployment(input.catalog);
  const { createSemanticClient } = require('../../gateway/client.cjs');
  const port = createSemanticClient(input.config);
  try {
    const client = createRemoteClient({ port, timeoutMs: Math.min(input.config.timeoutMs ?? 12000, 60000) });
    let value = input.action === 'ticket' || input.id ? await client.ticket(input.id) : await client.status();
    if (input.action === 'status' && !input.id) {
      const selectors = [{ kind: 'memory-floor', view: 'state' },
        ...require('./deployment-config.cjs').getDeploymentConfig().projects.map(project => ({ kind: 'managed-overuse', project: project.id }))];
      for (let at = 0; at < selectors.length; at += 32) value.objects.push(...(await client.read(selectors.slice(at, at + 32))).objects);
      const heartbeat = value.objects.find(x => x.entry.kind === 'dispatcher-heartbeat')?.value;
      const head = heartbeat?.queue?.find(x => x.position === 1);
      value.headTicket = head ? await client.ticket(head.ticketId) : null;
    }
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } finally { port.close(); }
})().catch(error => { process.stderr.write(error.message); process.exitCode = 3; });
