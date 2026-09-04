/**
 * Microsoft Entra ID (Azure AD) sign-in — OAuth2 authorization code flow
 * with PKCE, no external libraries (this project has nothing to
 * `npm install`, on purpose — see server/index.js's top comment).
 *
 * Nucleus's default login is its own per-person email+password accounts
 * (see server/index.js — setUserPassword/verifyPassword), which already
 * give the server a real, verified identity per session — so role-based
 * restrictions (Costs, Contract) are enforced server-side, not just a UI
 * choice, even without this module active. This module is an alternative
 * front door for teams that would rather everyone sign in with their
 * existing Microsoft 365 account instead of a Nucleus-specific password:
 * it verifies a person's real Microsoft 365 identity, then looks them up in
 * Nucleus's own Team roster (already a feature — see public/index.html's
 * Team & roles) to find their role, exactly the same way an email+password
 * account does. Adding or changing someone's role is then just editing the
 * roster inside Nucleus itself, same as always — no Azure AD role
 * assignment, no admin involvement beyond the one-time app registration
 * this all depends on.
 *
 * SSO is opt-in: it only activates once AZURE_TENANT_ID, AZURE_CLIENT_ID,
 * AZURE_CLIENT_SECRET, and APP_BASE_URL are all set (see .env.example).
 * Without them, the server behaves exactly as it always has (email+password
 * accounts) — nothing breaks for a deployment that hasn't done the Entra
 * app registration yet.
 */
const crypto = require('crypto');
const { verifyJwt, base64url } = require('./jwt');

function ssoConfig() {
  const tenantId = process.env.AZURE_TENANT_ID || '';
  const clientId = process.env.AZURE_CLIENT_ID || '';
  const clientSecret = process.env.AZURE_CLIENT_SECRET || '';
  const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  // Overridable only for local testing against a mock identity provider —
  // real deployments should never need to set this.
  const authorityBase = (process.env.AZURE_AUTHORITY_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
  if (!tenantId || !clientId || !clientSecret || !appBaseUrl) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    appBaseUrl,
    redirectUri: `${appBaseUrl}/auth/callback`,
    authorizeUrl: `${authorityBase}/${tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: `${authorityBase}/${tenantId}/oauth2/v2.0/token`,
    jwksUri: `${authorityBase}/${tenantId}/discovery/v2.0/keys`,
    issuer: `${authorityBase}/${tenantId}/v2.0`
  };
}

function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function buildAuthorizeUrl(cfg, { state, codeChallenge }) {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_mode', 'query');
  // openid + profile + email are basic OIDC scopes, not Graph API
  // permissions — they don't need Microsoft 365 admin consent, only the
  // signed-in user's own consent (which most tenants pre-grant for these).
  // Nucleus never calls Microsoft Graph; everything it needs (name, email)
  // comes straight back in the ID token.
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

async function exchangeCodeForTokens(cfg, { code, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier
  });
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error('Token exchange failed: ' + detail);
  }
  if (!json.id_token) throw new Error('Token response did not include an id_token');
  return json;
}

async function verifyIdToken(cfg, idToken) {
  return verifyJwt(idToken, cfg.jwksUri, {
    iss: cfg.issuer,
    aud: cfg.clientId,
    tid: cfg.tenantId
  });
}

// Finds the roster (Team & roles) entry whose email matches the verified
// identity, case-insensitively (email addresses aren't case-sensitive in
// practice, and Entra doesn't guarantee consistent casing back). Returns
// null — not a default role — when nobody in the roster matches, so an
// unrecognized sign-in is denied by default rather than silently trusted.
function findRosterMemberByEmail(state, email) {
  if (!email || !state || !Array.isArray(state.team)) return null;
  const needle = String(email).trim().toLowerCase();
  return state.team.find((m) => m.email && String(m.email).trim().toLowerCase() === needle) || null;
}

// ---- Minimal cookie helpers (used only for the short-lived PKCE/state
// handshake between /auth/start and /auth/callback — the app's real
// session stays a bearer token in localStorage, never a cookie, so nothing
// about the main app depends on cookies working inside a Teams iframe). ----
function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function setCookie(res, name, value, { maxAgeSeconds }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  ssoConfig,
  generatePkce,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  findRosterMemberByEmail,
  parseCookies,
  setCookie,
  clearCookie
};
