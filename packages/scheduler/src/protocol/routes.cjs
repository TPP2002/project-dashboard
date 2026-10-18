'use strict';
const s = require('./schema.cjs');
const { fail } = require('./json.cjs');
const windowsToCloud = [['windows', 'cloud']];
const cloudToWindows = [['cloud', 'windows']];
const ROUTES = Object.freeze(Object.fromEntries(Object.entries({
  'session.open': [['windows', 'cloud'], ['client', 'cloud']],
  submission: [['windows', 'cloud'], ['client', 'cloud']], command: [['windows', 'cloud'], ['client', 'cloud']],
  'report.started': windowsToCloud, 'report.finished': windowsToCloud,
  'waiting.upsert': windowsToCloud, 'waiting.delete': windowsToCloud, 'execution.heartbeat': windowsToCloud,
  'resident.renewal': windowsToCloud, 'origin.proof': windowsToCloud, 'process.stop-proof': windowsToCloud,
  'machine.observation': windowsToCloud, 'handoff.observe': windowsToCloud, 'snapshot.metadata': windowsToCloud,
  'launch.notice': windowsToCloud, 'lease.challenge': windowsToCloud,
  'origin.request': cloudToWindows, 'process.stop-request': cloudToWindows, 'handoff.intent': cloudToWindows,
  'handoff.publish': cloudToWindows, 'handoff.observe-request': cloudToWindows, 'handoff.quarantine': cloudToWindows,
  'snapshot.request': cloudToWindows, 'lease.renewal': cloudToWindows,
  'artifact.read': [['cloud', 'windows'], ['windows', 'cloud'], ['client', 'cloud']],
  'log.read': [['cloud', 'windows'], ['windows', 'cloud'], ['client', 'cloud']],
  'artifact.chunk': [['windows', 'cloud'], ['cloud', 'windows'], ['cloud', 'client']],
  'log.chunk': [['windows', 'cloud'], ['cloud', 'windows'], ['cloud', 'client']],
  'state.read': [['windows', 'cloud'], ['client', 'cloud']],
  'state.snapshot': [['cloud', 'windows'], ['cloud', 'client']],
  'projection.catalog': [['windows', 'cloud'], ['client', 'cloud']], 'projection.read': [['windows', 'cloud'], ['client', 'cloud']],
  'projection.manifest': [['cloud', 'windows'], ['cloud', 'client']], 'projection.chunk': [['cloud', 'windows'], ['cloud', 'client']],
  result: [['windows', 'cloud'], ['cloud', 'windows'], ['cloud', 'client']],
}).map(([kind, routes]) => [kind, Object.freeze(routes.map(pair => Object.freeze(pair)))])));
function validateRoute(kind, senderRole, receiverRole) {
  s.enumeration(['cloud', 'windows', 'client'])(senderRole);
  s.enumeration(['cloud', 'windows', 'client'])(receiverRole);
  if (!Object.hasOwn(ROUTES, kind) || !ROUTES[kind].some(([from, to]) => from === senderRole && to === receiverRole)) fail('DIRECTION_DENIED');
}
module.exports = { ROUTES, validateRoute };
