/**
 * Server-side enforcement of the same Costs/Contract visibility rules the
 * app's UI already follows (public/index.html: FOREMAN_ALLOWED_TABS,
 * CONTRACT_TAB_ALLOWED_ROLES) — kept in sync with those by hand, since this
 * is a small, deliberately-scoped list, not a general framework.
 *
 * Scope, on purpose: this covers the genuinely financial/contract areas Greg
 * asked to secure. It used to be one combined "Costs" concern (cost impacts,
 * invoices, projected costs) plus Contract, but Costs is now split in two:
 *   - Issues (Cost Impacts) — a Foreman needs these too. The client embeds
 *     the full Cost Impacts view directly in Field Tool Kit for Foreman
 *     identities (renderIssues(job, issues, true), dollar amounts already
 *     stripped client-side) so a Foreman can report a cost impact from the
 *     field. Bundling `issues` into the old Foreman-exclusive Costs
 *     allow-list meant a Foreman's own browser was handed an empty `issues`
 *     array, so a Foreman's cost-impact report silently vanished on save —
 *     never actually reached the server. Foreman is now included here.
 *   - Financial (Invoices) — real dollar amounts on the job. Foreman must
 *     still never see this, so it keeps the original, Foreman-exclusive
 *     allow-list under a new name.
 * `projectedCosts` is gone from both: the old "Projected Costs" sub-tab was
 * retired (its data folded into the Contract tab's Green Sheet budget lines,
 * which were never gated behind Financial in the first place — see
 * CONTRACT_KEYS below), so there's nothing left to filter under that key.
 * Contract (Green Sheet budgets/quotes, contract documents) is unchanged.
 * Other UI-hidden-from-Foreman tabs (Change Orders, Hours, Engineering,
 * Logs, Overview) are unchanged from before: hidden in the UI, still
 * present in the underlying data for any authenticated session. Worth
 * knowing, not a silent gap — ask if those should be covered too.
 *
 * Three roles lists explicitly (allow-lists, not deny-lists) so an unknown
 * or unmatched role is denied by default rather than accidentally let
 * through.
 */
const ISSUES_ALLOWED_ROLES = ['Operations Manager', 'Project Manager', 'Engineering Manager', 'Superintendent', 'Foreman'];
const FINANCIAL_ALLOWED_ROLES = ['Operations Manager', 'Project Manager', 'Engineering Manager', 'Superintendent'];
const CONTRACT_ALLOWED_ROLES = ['Operations Manager', 'Project Manager', 'App Manager'];

const ISSUES_KEYS = ['issues'];
const FINANCIAL_KEYS = ['invoices'];
const CONTRACT_KEYS = ['greenSheets', 'greenSheetQuotes'];

function canSeeIssues(role) {
  return ISSUES_ALLOWED_ROLES.includes(role);
}
function canSeeFinancials(role) {
  return FINANCIAL_ALLOWED_ROLES.includes(role);
}
function canSeeContract(role) {
  return CONTRACT_ALLOWED_ROLES.includes(role);
}

// GET: what a session with this role is allowed to receive at all.
function filterStateForRole(state, role) {
  const issuesOk = canSeeIssues(role);
  const financialOk = canSeeFinancials(role);
  const contractOk = canSeeContract(role);
  if (issuesOk && financialOk && contractOk) return state;
  const out = Object.assign({}, state);
  if (!issuesOk) {
    ISSUES_KEYS.forEach((k) => { out[k] = []; });
  }
  if (!financialOk) {
    FINANCIAL_KEYS.forEach((k) => { out[k] = []; });
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
  const issuesOk = canSeeIssues(role);
  const financialOk = canSeeFinancials(role);
  const contractOk = canSeeContract(role);
  const merged = Object.assign({}, incomingState);
  if (!issuesOk) {
    ISSUES_KEYS.forEach((k) => { merged[k] = existingState[k]; });
  }
  if (!financialOk) {
    FINANCIAL_KEYS.forEach((k) => { merged[k] = existingState[k]; });
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

module.exports = {
  canSeeIssues,
  canSeeFinancials,
  canSeeContract,
  filterStateForRole,
  reconcileIncomingState,
  ISSUES_KEYS,
  FINANCIAL_KEYS,
  CONTRACT_KEYS
};
