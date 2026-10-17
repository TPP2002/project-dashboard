'use strict';
// Command receipts are storage-only idempotency metadata, including in nested
// CLI responses. Apply at serialization without mutating the cached ledger.
function publicJson(key, value) { return key === '_commandReceipts' ? undefined : value; }
module.exports = { publicJson };
