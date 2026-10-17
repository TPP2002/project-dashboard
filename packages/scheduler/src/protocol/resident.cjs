'use strict';
const s = require('./schema.cjs');
const { canonicalJson, ProtocolValidationError } = require('./json.cjs');
const sourceProof = (v, p) => {
  s.enumeration(['original-object-acl', 'ipc-peer'])(v?.method, `${p}.method`);
  s.fields({ proofId: s.id, submissionHash: s.hash, observedOwnerSid: s.pattern(/^S-1-[0-9]+(?:-[0-9]+){1,15}$/),
    method: s.enumeration(['original-object-acl', 'ipc-peer']),
    ...(v.method === 'original-object-acl' ? { originalObject: s.fields({ objectId: s.id, hash: s.hash, size: s.count }) } : { callId: s.id }),
  })(v, p);
};
const residentFields = { stage: s.enumeration(['resident']), ticketId: s.ticketId, attemptId: s.attemptId,
  permitToken: s.text(256), renewer: s.controller, source: sourceProof };
const binding = s.fields(residentFields);
// Reservation bookkeeping is not a job-tree execution lease. A dead wrapper is not a stopped application.
function evaluateResidentReservation(identity, context) {
  try {
    s.validate(binding, identity);
    if (!context || canonicalJson(identity) !== canonicalJson(context.expectedIdentity) || context.sourceVerified !== true) return { retain: true, reason: 'RESIDENT_IDENTITY_UNKNOWN' };
    if (context.applicationObservation === 'exit-confirmed' && context.applicationBirthVerified === true && context.observationFresh === true) {
      s.controller(context.expectedApplicationBirth); s.controller(context.observedApplicationBirth);
      if (canonicalJson(context.expectedApplicationBirth) !== canonicalJson(context.observedApplicationBirth)) return { retain: true, reason: 'RESIDENT_APPLICATION_BIRTH_MISMATCH' };
      return { retain: false, reason: 'RESIDENT_APPLICATION_EXIT_CONFIRMED' };
    }
    return { retain: true, reason: context.renewalFresh === true ? 'RESIDENT_RENEWAL_FRESH' : 'RESIDENT_UNPROVEN_STOP' };
  } catch (error) {
    if (error instanceof ProtocolValidationError || error instanceof TypeError) return { retain: true, reason: 'RESIDENT_IDENTITY_UNKNOWN' };
    throw error;
  }
}
module.exports = { sourceProof, residentFields, binding, evaluateResidentReservation };
