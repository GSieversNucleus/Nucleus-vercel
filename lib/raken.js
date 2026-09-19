/**
 * Raken connection — OAuth 2.0 plus a thin, read-only API client.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Greg's field crews write their daily reports in Raken. This pulls the
 * resulting documents — daily report PDFs, field photos, checklists and
 * observations — back onto the matching Nucleus job, so the PM isn't opening
 * two apps to see what happened on site.
 *
 * SECURITY, AND WHY IT IS SHAPED THIS WAY
 * ---------------------------------------
 * The client secret NEVER reaches the browser. The whole OAuth exchange
 * happens here, server-side, and Greg's actual Raken sign-in happens on
 * Raken's own page — Nucleus never sees his Raken password. The resulting
 * tokens are written through store.js's encrypted envelope, because a Raken
 * refresh token is valid for 180 days and must not sit in plain text in a
 * Redis backup.
 *
 * Raken's docs state that "Redirect URI Validation [is] NOT enforced
 * currently in Raken", which means Raken will not, on its own, stop an
 * authorization code from being sent somewhere else. That makes the CSRF
 * defence OUR job, so the callback below requires a `state` value that
 * matches a short-lived, HttpOnly cookie this server set at the start of the
 * flow — the same pattern lib/auth.js already uses for Microsoft sign-in. A
 * callback without that cookie is refused.
 *
 * CONNECTION SCOPE
 * ----------------
 * One connection per Nucleus deployment, not per person: Raken is the
 * company's account, and a daily report belongs to the job, not to whoever
 * happened to click Connect. Only an App Manager can connect or disconnect
 * (enforced in the router, not here).
 *
 * INERT UNTIL CONFIGURED
 * ----------------------
 * With no RAKEN_CLIENT_ID / RAKEN_CLIENT_SECRET set, isConfigured() is false
 * and every route returns a clear "not set up" rather than erroring. Nothing
 * about the rest of Nucleus changes.
 */
const AUTHORIZE_URL = 'https://app.rakenapp.com/oauth/authorize';
const TOKEN_URL = 'https://app.rakenapp.com/oauth/token';
const API_BASE = 'https://developer.rakenapp.com/api';

// Refresh this far before the access token actually expires, so a long
// import can't have the token die out from under it mid-run.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function config() {
  const clientId = process.env.RAKEN_CLIENT_ID || '';
  const clientSecret = process.env.RAKEN_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
function isConfigured() { return !!config(); }

/**
 * The callback URL Raken sends the browser back to. Must match what was
 * registered on the Raken OAuth app. Derived from the deployment's own
 * hostname so production and a preview each come back to themselves, with
 * RAKEN_REDIRECT_URI as an override.
 */
function redirectUri(req) {
  if (process.env.RAKEN_REDIRECT_URI) return process.env.RAKEN_REDIRECT_URI;
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  const proto = (req && req.headers['x-forwarded-proto']) || 'https';
  return `${proto}://${host}/auth/raken/callback`;
}

function buildAuthorizeUrl(req, state) {
  const cfg = config();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(req),
    // Raken's docs don't document `state`, but sending it costs nothing and
    // it is echoed back by any spec-conforming server. The cookie check in
    // the router is what the flow actually relies on.
    state
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString()
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
  if (!res.ok || !data || !data.access_token) {
    const detail = (data && (data.error_description || data.error)) || text.slice(0, 200);
    throw Object.assign(new Error(`Raken token request failed (${res.status}): ${detail}`), { status: res.status });
  }
  return {
    accessToken: data.access_token,
    // Refresh tokens rotate, so the response's refresh_token wins whenever
    // one is present; only fall back to the old one if Raken omitted it.
    refreshToken: data.refresh_token || body.refresh_token || '',
    expiresAt: Date.now() + (Number(data.expires_in) || 36000) * 1000
  };
}

async function exchangeCode(req, code) {
  const cfg = config();
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(req)
  });
}

async function refreshTokens(refreshToken) {
  const cfg = config();
  return postToken({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken
  });
}

/**
 * Returns a usable access token, refreshing and re-saving if it's close to
 * expiry. `store` is passed in rather than required at the top so this file
 * stays a pure Raken concern and can be exercised on its own.
 */
async function currentAccessToken(store) {
  const saved = await store.loadRakenTokens();
  if (!saved || !saved.accessToken) return null;
  if (saved.expiresAt - Date.now() > REFRESH_MARGIN_MS) return saved.accessToken;
  if (!saved.refreshToken) return null;
  const fresh = await refreshTokens(saved.refreshToken);
  await store.saveRakenTokens(Object.assign({}, saved, fresh));
  return fresh.accessToken;
}

/**
 * A read-only GET against the Raken API. Deliberately GET-only: nothing in
 * Nucleus has any business writing into Raken, and not having a write path
 * at all is a stronger guarantee than remembering not to call one.
 */
async function apiGet(store, path, params) {
  const token = await currentAccessToken(store);
  if (!token) throw Object.assign(new Error('Raken is not connected'), { code: 'not_connected' });
  const url = new URL(API_BASE + (path.startsWith('/') ? path : '/' + path));
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`Raken API ${res.status} on ${path}: ${text.slice(0, 200)}`), { status: res.status });
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Raken API returned non-JSON on ${path}`); }
}

/**
 * Downloads a file Raken pointed us at (a report PDF, a photo). Raken's file
 * URLs are usually pre-signed and don't need the bearer token, but sending it
 * is harmless for raken-hosted paths and necessary for API-hosted ones.
 *
 * Only https URLs on Raken's own domains are allowed. The URLs come from API
 * responses rather than from a user, but an import that blindly fetched
 * whatever a response contained would be a server-side request forgery
 * waiting to happen, so the allowlist is enforced here rather than trusted.
 */
const ALLOWED_FILE_HOSTS = /(^|\.)(rakenapp\.com|amazonaws\.com)$/i;
async function fetchFile(store, fileUrl) {
  let url;
  try { url = new URL(fileUrl); }
  catch (e) { throw new Error('Raken returned a file URL that could not be parsed'); }
  if (url.protocol !== 'https:' || !ALLOWED_FILE_HOSTS.test(url.hostname)) {
    throw new Error(`Refusing to fetch a Raken file from an unexpected host: ${url.hostname}`);
  }
  const token = await currentAccessToken(store);
  const res = await fetch(url.toString(), {
    headers: token && /rakenapp\.com$/i.test(url.hostname) ? { Authorization: 'Bearer ' + token } : {}
  });
  if (!res.ok) throw new Error(`Could not download that file from Raken (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

module.exports = {
  API_BASE,
  isConfigured,
  redirectUri,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  currentAccessToken,
  apiGet,
  fetchFile
};
