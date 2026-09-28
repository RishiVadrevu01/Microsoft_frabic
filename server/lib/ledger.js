'use strict';
// Small helpers over the decision log (kept apart from decisions.js so the
// read-only views do not depend on the write path).

const decisionsForPool = (records, poolId) => records.filter((r) => r.pool_id === poolId).slice().reverse();

// Latest decision per pool, trimmed for list views.
function latestByPool(records) {
  const out = {};
  for (const r of records) {
    out[r.pool_id] = {
      decision_id: r.decision_id, decision: r.decision, decided_by: r.decided_by, decided_at: r.decided_at,
      quantity_cu: r.quantity_cu, override: r.override, order_id: r.order_id || null,
      // a first approval that is waiting for a second person is not an approval yet
      approval_state: r.approval ? r.approval.state : 'complete',
    };
  }
  return out;
}

module.exports = { decisionsForPool, latestByPool };
