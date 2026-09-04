/**
 * Server-side enforcement of the same Costs/Contract visibility rules the
 * app's UI already follows (public/index.html: FOREMAN_ALLOWED_TABS,
 * CONTRACT_TAB_ALLOWED_ROLES) — kept in sync with those by hand, since this
 * is a small, deliberately-scoped list, not a general framework.
 *
 * Scope, on purpose: this covers the two genuinely financial areas Greg
 * asked to secure — Costs (cost impacts, invoices, projected costs) and
 * Contract (Green Sheet budgets/quotes, contract documents). Other
 * UI-hidden-from-Foreman tabs (Change Orders, Hours, Engineering, Logs,
 * Overview) are unchanged from before: hidden in the UI, still present in
 * the underlying data for any authenticated session. Worth knowing, not a
 * silent gap — ask if those should be covered too.
 *
 * Two roles list explicitly (allow-lists, not deny-lists) so an unknown or
 * unmatched role is denied by default rather than accidentally let through.
 */
const COSTS_ALLOWED_ROLES = ['Operations Manager', 'Project Manager', 'Engineering Manager', 'Superintendent'];
const CONTRACT_ALLOWED_ROLES = ['Operations Manager', 'Project Manager'];

const COSTS_KEYS = ['issues', 'invoices', 'projectedCosts'];
const CONTRACT_KEYS = ['greenSheets', 'greenSheetQuotes'];

function canSeeCosts(role) {
  return COSTS_ALLOWED_ROLES.includes(role);
}
function canSeeContract(role) {
  return CONTRACT_ALLOWED_ROLES.includes(role);
}

// GET: what a session with this role is allowed to receive at all.
function filterStateForRole(state, role) {
  const costsOk = canSeeCosts(role);
  const contractOk = canSeeContract(role);
  if (costsOk && contractOk) return state;
  const out = Object.assign({}, state);
  if (!costsOk) {
    COSTS_KEYS.forEach((k) => { out[k] = []; });
  }
  if (!contractOk) {
    CONTRACT_KEYS.forEach((k) => { out[k] = []; });
    out.jobs = (out.jobs || []).map((j) => {
      if (!j || !('contractDocs' in j)) return j;
      const copy = Object.assign({}, j);
      delete copy.contractDocs;
      return copy;
    });
  }
  return out;
}

// POST: a session that can't SEE a given piece of data must never be able
// to change it either — including by accident, just by saving an unrelated
// edit while holding an incomplete local copy (their client never received
// the restricted fields in the first place, so its own in-memory state is
// missing them; naively storing whatever it posts would silently erase the
// real values). For every restricted key, this discards whatever the
// client sent and carries the server's existing value forward untouched.
// Non-restricted keys pass through from the client exactly as before.
function reconcileIncomingState(existingState, incomingState, role) {
  const costsOk = canSeeCosts(role);
  const contractOk = canSeeContract(role);
  const merged = Object.assign({}, incomingState);
  if (!costsOk) {
    COSTS_KEYS.forEach((k) => { merged[k] = existingState[k]; });
  }
  if (!contractOk) {
    CONTRACT_KEYS.forEach((k) => { merged[k] = existingState[k]; });
    const existingJobsById = new Map((existingState.jobs || []).map((j) => [j.id, j]));
    merged.jobs = (incomingState.jobs || []).map((j) => {
      const prev = existingJobsById.get(j.id);
      const out = Object.assign({}, j);
      if (prev && 'contractDocs' in prev) out.contractDocs = prev.contractDocs;
      else delete out.contractDocs;
      return out;
    });
  }
  return merged;
}

module.exports = { canSeeCosts, canSeeContract, filterStateForRole, reconcileIncomingState, COSTS_KEYS, CONTRACT_KEYS };
