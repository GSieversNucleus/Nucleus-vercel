/**
 * Nucleus's whole backend, as a single Vercel serverless function.
 *
 * Why one function instead of one file per route (the more common Vercel
 * pattern, e.g. api/login.js, api/state.js, ...): the routing logic below is
 * a direct, close port of the Render build's server/index.js — same checks,
 * same order, same response shapes — and keeping it as one router made that
 * port mechanical and easy to verify line-by-line against the original,
 * rather than re-deriving the same logic split across a dozen small files.
 * vercel.json rewrites every request this app cares about (/api/*, /auth/*,
 * and /data/state.json) to this one function; see that file for the routing
 * table. Static files (everything under public/) are served directly by
 * Vercel — this function is never involved in those.
 *
 * See lib/store.js for the persistence layer (Redis via Upstash, replacing
 * the Render build's local files + in-memory Maps) and README.md for how
 * this gets deployed.
 */
const crypto = require('crypto');
const store = require('../lib/store');
const auth = require('../lib/auth');
const roles = require('../lib/roles');
const webpush = require('../lib/webpush');
const { geocodeAddress } = require('../lib/geocode');
const { postToTeamsWebhook } = require('../lib/teamsWebhook');
const blob = require('../lib/blob');
const raken = require('../lib/raken');

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB — matches the app's own MAX_STATE_BYTES headroom

// ---- Push notifications: a real phone/tablet alert for a cost impact or
// request assigned to you, even with Nucleus closed — see lib/webpush.js
// for how this is sent (RFC 8291/8292, Node's own crypto only, no paid
// service or npm dependency, identical to the Render build). Needs one
// VAPID keypair, generated once (run `node generate-vapid-keys.js`) and set
// as these two env vars in Vercel's project settings — see .env.example.
// Missing either one just means push is unavailable; nothing else about
// the app depends on it. ----
const vapidKeys = (process.env.NUCLEUS_VAPID_PUBLIC_KEY && process.env.NUCLEUS_VAPID_PRIVATE_KEY)
  ? { publicKey: process.env.NUCLEUS_VAPID_PUBLIC_KEY, privateKey: process.env.NUCLEUS_VAPID_PRIVATE_KEY }
  : null;
const VAPID_SUBJECT = 'mailto:' + (process.env.NUCLEUS_ADMIN_EMAIL || 'notifications@example.com');
function notificationPushTitle(type) {
  return type === 'costImpact' ? 'Nucleus — Cost impact' : 'Nucleus — Request';
}

// ---- Microsoft Teams channel posts (Greg: "Post updates into a Teams
// channel" — for a Project Manager, the two things this app already treats
// as notification-worthy for a PM (new PM Request For Field, new Cost
// Impact — same two types notifyNewPushNotifications above already
// pushes to a phone), plus, since Greg also asked for "all office
// personnel", every new Office Calendar time-off entry (the whole point of
// that page per Greg's own words was "so everyone knows when people are
// out of the office"). One line per event, kept deliberately narrow so the
// channel doesn't turn into noise — this does NOT mirror every notification
// or every state change. Inactive with no NUCLEUS_TEAMS_WEBHOOK_URL set;
// see lib/teamsWebhook.js for the webhook mechanics and how Greg gets that
// URL from his own Teams channel. ----
const TEAMS_WEBHOOK_URL = process.env.NUCLEUS_TEAMS_WEBHOOK_URL || null;
function timeOffDateLabel(t) {
  return t.startDate === t.endDate ? t.startDate : `${t.startDate} → ${t.endDate}`;
}
async function notifyTeamsChannel(oldState, newState) {
  if (!TEAMS_WEBHOOK_URL) return;

  // New PM Request / Cost Impact notifications. notifyMembers() (client-side)
  // writes one notification entry PER RECIPIENT with the same refId and
  // message, so de-dupe by refId — one Teams line per underlying event, not
  // one per person it was addressed to.
  const oldNotifIds = new Set((oldState.notifications || []).map((n) => n.id));
  const newNotifs = (newState.notifications || []).filter((n) => !oldNotifIds.has(n.id) && (n.type === 'pmRequest' || n.type === 'costImpact'));
  const seenRefIds = new Set();
  for (const n of newNotifs) {
    const dedupeKey = n.refId || n.id;
    if (seenRefIds.has(dedupeKey)) continue;
    seenRefIds.add(dedupeKey);
    const icon = n.type === 'costImpact' ? '💰' : '📋';
    await postToTeamsWebhook(TEAMS_WEBHOOK_URL, `${icon} ${n.message}`);
  }

  // New Office Calendar (vacation/work-trip) entries — see state.timeOff /
  // renderOfficeCalendarSection in public/index.html.
  const oldTimeOffIds = new Set((oldState.timeOff || []).map((t) => t.id));
  const newTimeOff = (newState.timeOff || []).filter((t) => !oldTimeOffIds.has(t.id));
  for (const t of newTimeOff) {
    const person = (newState.team || []).find((m) => m.id === t.personId);
    const name = person ? person.name : '(removed team member)';
    await postToTeamsWebhook(TEAMS_WEBHOOK_URL, `🌴 ${name} — ${t.type} on the Office Calendar: ${timeOffDateLabel(t)}`);
  }
}
// Called right after a state save succeeds, comparing the notifications
// array before and after to find entries that are genuinely new (not just
// re-saved unchanged), then pushing to every device the recipient has
// subscribed on. A subscription the push service reports gone (404/410) is
// removed so nothing keeps retrying it forever; any other failure is logged
// and otherwise ignored — one bad send must never affect the save itself
// (already committed by the time this runs) or anyone else's push. Same
// logic as the Render build's server/index.js, swapping its in-memory
// pushSubs Map for store.js's Redis-backed one — but AWAITED by its caller
// here rather than fire-and-forget, since a serverless function's process
// can be torn down right after its response is sent (see the call site).
async function notifyNewPushNotifications(oldNotifications, newNotifications) {
  if (!vapidKeys) return;
  const oldIds = new Set((oldNotifications || []).map((n) => n.id));
  const added = (newNotifications || []).filter((n) => !oldIds.has(n.id));
  if (added.length === 0) return;
  const subs = await store.loadPushSubs();
  for (const n of added) {
    const matches = Object.entries(subs).filter(([, sub]) => sub.teamMemberId === n.recipientMemberId);
    if (matches.length === 0) continue;
    const payload = { title: notificationPushTitle(n.type), body: n.message, jobId: n.jobId, refId: n.refId, notifType: n.type };
    for (const [endpoint, sub] of matches) {
      try {
        const result = await webpush.sendWebPush({ endpoint, keys: sub.keys }, payload, vapidKeys, { subject: VAPID_SUBJECT });
        if (result.gone) {
          await store.removePushSub(endpoint);
        } else if (!result.ok) {
          console.warn('Push send failed for', endpoint, '-', result.error);
        }
      } catch (e) {
        console.error('Push send threw for', endpoint, e);
      }
    }
  }
}

// ---- One-time-per-instance admin bootstrap. A serverless instance can be
// reused across several requests before it's recycled, so this only needs
// to run once per instance (a module-level flag), not on every request —
// see lib/store.js's bootstrapAdminAccount for what this actually does and
// why it exists. ----
let adminBootstrapped = false;
async function ensureAdminBootstrapped() {
  if (adminBootstrapped) return;
  adminBootstrapped = true; // set first so a slow/failed attempt doesn't retry on every request in a hot loop
  try { await store.bootstrapAdminAccount(); }
  catch (e) { console.error('Admin bootstrap failed:', e); }
}

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none';"
};

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, SECURITY_HEADERS, extraHeaders || {}));
  res.end(body);
}

// Vercel Node functions may already parse a JSON body into req.body for you
// — but rather than depend on exactly how/when that happens, this reads the
// raw stream itself (identical to the Render build), and only falls back to
// req.body if the stream is already drained. Either path enforces the same
// MAX_BODY_BYTES cap the Render build always has.
function readJSONBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('invalid json'), { code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Resolves a session's identity (role, matching Team roster entry, etc.)
// fresh from the current roster — same helper the Render build has, shared
// by every route below so "who am I / what am I allowed to see" is always
// computed the same way, in exactly one place.
function resolveIdentity(sessionAuth, state) {
  if (!sessionAuth) return null;
  const member = auth.findRosterMemberByEmail(state, sessionAuth.email);
  return {
    email: sessionAuth.email,
    name: (member && member.name) || sessionAuth.name || sessionAuth.email,
    role: member ? member.role : null,
    teamMemberId: member ? member.id : null,
    matched: !!member
  };
}

module.exports = async (req, res) => {
  try {
    await ensureAdminBootstrapped();
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/api/auth-mode') {
      return sendJSON(res, 200, { sso: !!auth.ssoConfig() });
    }

    if (req.method === 'POST' && url === '/api/login') {
      if (auth.ssoConfig()) {
        return sendJSON(res, 410, {
          error: 'sso_required',
          message: 'This deployment uses Microsoft 365 sign-in instead of email+password accounts.'
        });
      }
      const ip = clientIp(req);
      if (await store.isRateLimited(ip)) {
        return sendJSON(res, 429, { error: 'too_many_attempts' }, { 'Retry-After': '900' });
      }
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const email = store.normalizeEmail(body.email);
      const user = email ? await store.findUser(email) : null;
      if (!user || !store.verifyPassword(String(body.password || ''), user.passwordHash)) {
        await store.recordFailedLogin(ip);
        return sendJSON(res, 401, { error: 'wrong_credentials' });
      }
      const token = await store.issueToken({ type: 'account', email });
      const doc = await store.readState();
      const identity = resolveIdentity({ email }, doc.state);
      return sendJSON(res, 200, { token, identity });
    }

    if (req.method === 'GET' && url === '/api/me') {
      const identity0 = await store.getSession(getBearerToken(req));
      if (!identity0) return sendJSON(res, 401, { error: 'not_authenticated' });
      const doc = await store.readState();
      return sendJSON(res, 200, { identity: resolveIdentity(identity0, doc.state) });
    }

    // ---- Set or reset someone's password. Restricted to App Manager — a
    // dedicated role, separate from Operations Manager, for whoever's
    // responsible for onboarding people: adding them to Team and managing
    // their logins. Login creation is controlled centrally, not something
    // any signed-in person (or Operations Manager, which handles jobs/
    // PMs/Costs/Contract instead) can do to anyone else. Everyone can
    // still change their OWN password below, regardless of role. ----
    if (req.method === 'POST' && url === '/api/accounts/set-password') {
      if (auth.ssoConfig()) return sendJSON(res, 410, { error: 'sso_required' });
      const identity0 = await store.getSession(getBearerToken(req));
      if (!identity0) return sendJSON(res, 401, { error: 'not_authenticated' });
      const doc0 = await store.readState();
      const requester = resolveIdentity(identity0, doc0.state);
      if (!requester || requester.role !== 'App Manager') {
        return sendJSON(res, 403, {
          error: 'forbidden',
          message: 'Only an App Manager can create or reset a login.'
        });
      }
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const email = store.normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJSON(res, 400, { error: 'bad_email' });
      }
      if (password.length < store.MIN_PASSWORD_LEN) {
        return sendJSON(res, 400, { error: 'weak_password', message: `Password must be at least ${store.MIN_PASSWORD_LEN} characters.` });
      }
      await store.setUserPassword(email, password);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/accounts/change-password') {
      if (auth.ssoConfig()) return sendJSON(res, 410, { error: 'sso_required' });
      const identity0 = await store.getSession(getBearerToken(req));
      if (!identity0 || identity0.type !== 'account') return sendJSON(res, 401, { error: 'not_authenticated' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const user = await store.findUser(identity0.email);
      if (!user || !store.verifyPassword(String(body.currentPassword || ''), user.passwordHash)) {
        return sendJSON(res, 401, { error: 'wrong_password', message: 'Current password is incorrect.' });
      }
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < store.MIN_PASSWORD_LEN) {
        return sendJSON(res, 400, { error: 'weak_password', message: `Password must be at least ${store.MIN_PASSWORD_LEN} characters.` });
      }
      await store.setUserPassword(identity0.email, newPassword);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/logout') {
      const token = getBearerToken(req);
      if (token) await store.deleteSession(token);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Attachment storage (Vercel Blob). See lib/blob.js for WHY this
    // exists: attachments used to be inlined into the state document, and
    // Vercel's ~4.5MB request-body cap therefore doubled as a hard ceiling on
    // every photo and PDF in the app combined. Files now go browser ->
    // private Blob store directly; these routes only ever hand out
    // short-lived presigned URLs, never file bytes.
    //
    // Every route is behind the same bearer gate as the rest of the app. That
    // gate is the ONLY thing standing between the open internet and write
    // access to the store, so it is checked first, before anything is parsed.
    // ----
    if (url === '/api/blob/status' && req.method === 'GET') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      return sendJSON(res, 200, { enabled: blob.isConfigured(), maxFileBytes: blob.MAX_FILE_BYTES });
    }

    if (url === '/api/blob/sign-upload' && req.method === 'POST') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      if (!blob.isConfigured()) return sendJSON(res, 503, { error: 'blob_not_configured' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const size = Number(body.size) || 0;
      if (size > blob.MAX_FILE_BYTES) {
        return sendJSON(res, 413, { error: 'file_too_large', maxFileBytes: blob.MAX_FILE_BYTES });
      }
      const pathname = blob.makePathname(body.name);
      try {
        const signed = await blob.signUpload(pathname);
        return sendJSON(res, 200, { pathname, uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt });
      } catch (e) {
        console.error('blob sign-upload failed', e);
        return sendJSON(res, 502, { error: 'blob_unavailable' });
      }
    }

    if (url === '/api/blob/sign-reads' && req.method === 'POST') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      if (!blob.isConfigured()) return sendJSON(res, 503, { error: 'blob_not_configured' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      // Capped so one render of a very large job can't ask for thousands of
      // signatures in a single request; the client batches past this itself.
      const pathnames = (Array.isArray(body.pathnames) ? body.pathnames : [])
        .filter((p) => typeof p === 'string' && p)
        .slice(0, 200);
      if (!pathnames.length) return sendJSON(res, 200, { urls: {}, expiresAt: Date.now() });
      try {
        const signed = await blob.signReads(pathnames);
        return sendJSON(res, 200, signed);
      } catch (e) {
        console.error('blob sign-reads failed', e);
        return sendJSON(res, 502, { error: 'blob_unavailable' });
      }
    }

    // ---- Raken connection. See lib/raken.js for the security shape; the
    // short version is that the client secret never leaves this server and
    // Greg's Raken sign-in happens on Raken's own page.
    //
    // Connecting is App Manager only — it binds the whole deployment to one
    // Raken account, which is not a thing any signed-in person should be able
    // to do or undo. Reading is open to any signed-in user, because the point
    // is for PMs to pull documents onto their jobs. ----
    async function requireAppManager(req2) {
      const identity0 = await store.getSession(getBearerToken(req2));
      if (!identity0) return { error: 401, body: { error: 'not_authenticated' } };
      const doc0 = await store.readState();
      const who = resolveIdentity(identity0, doc0.state);
      if (!who || who.role !== 'App Manager') {
        return { error: 403, body: { error: 'forbidden', message: 'Only an App Manager can change the Raken connection.' } };
      }
      return { who };
    }

    if (url === '/api/raken/status' && req.method === 'GET') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      const tokens = raken.isConfigured() ? await store.loadRakenTokens() : null;
      return sendJSON(res, 200, {
        configured: raken.isConfigured(),
        connected: !!(tokens && tokens.refreshToken),
        connectedAt: (tokens && tokens.connectedAt) || null,
        connectedBy: (tokens && tokens.connectedBy) || null,
        redirectUri: raken.isConfigured() ? raken.redirectUri(req) : null
      });
    }

    // Returns the URL to open, rather than redirecting: a browser navigation
    // can't carry the bearer token, and putting a session token in a query
    // string to work around that would be worse than the problem. This is an
    // authenticated POST that hands back a URL and sets the CSRF cookie the
    // callback will check.
    if (url === '/api/raken/connect-url' && req.method === 'POST') {
      const gate = await requireAppManager(req);
      if (gate.error) return sendJSON(res, gate.error, gate.body);
      if (!raken.isConfigured()) {
        return sendJSON(res, 503, {
          error: 'raken_not_configured',
          message: 'Set RAKEN_CLIENT_ID and RAKEN_CLIENT_SECRET in the Vercel project settings first.'
        });
      }
      const state = crypto.randomBytes(16).toString('hex');
      auth.setCookie(res, 'nucleus_raken_state', JSON.stringify({ state, email: gate.who.email }), { maxAgeSeconds: 600 });
      return sendJSON(res, 200, { authorizeUrl: raken.buildAuthorizeUrl(req, state) });
    }

    if (url === '/auth/raken/callback' && req.method === 'GET') {
      // Tagged with source:'raken' because the Microsoft 365 sign-in popup
      // posts to the same window with a {token}/{error} shape — an untagged
      // payload would be ambiguous to whichever listener saw it first.
      function sendRakenResult(payload) {
        payload = Object.assign({ source: 'raken' }, payload);
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Raken</title></head><body>
<script>
(function(){
  var payload = ${JSON.stringify(payload)};
  try {
    if (window.opener) { window.opener.postMessage(payload, window.location.origin); window.close(); }
    else { document.body.textContent = payload.ok ? 'Raken connected — you can close this window.' : (payload.error || 'Raken connection failed.'); }
  } catch (e) { document.body.textContent = 'Raken connected. Close this window and reload Nucleus.'; }
})();
</script>
<p>Finishing up…</p>
</body></html>`;
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
        res.end(html);
      }

      const reqUrl = new URL(req.url, 'https://internal');
      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const cookies = auth.parseCookies(req);
      auth.clearCookie(res, 'nucleus_raken_state');
      let pending = null;
      try { pending = JSON.parse(cookies['nucleus_raken_state'] || 'null'); } catch (e) { pending = null; }

      // Raken does not enforce redirect-URI validation, so this cookie check
      // is the thing standing between us and someone else's authorization
      // code being planted here. No cookie, no connection.
      if (!pending || !pending.state) {
        return sendRakenResult({ ok: false, error: 'This sign-in took too long or was started somewhere else. Try Connect again.' });
      }
      if (returnedState && returnedState !== pending.state) {
        return sendRakenResult({ ok: false, error: 'Raken sent back a mismatched sign-in. Nothing was connected — try Connect again.' });
      }
      if (!code) {
        return sendRakenResult({ ok: false, error: reqUrl.searchParams.get('error_description') || 'Raken did not return an authorization code.' });
      }
      try {
        const tokens = await raken.exchangeCode(req, code);
        await store.saveRakenTokens(Object.assign({}, tokens, {
          connectedAt: new Date().toISOString(),
          connectedBy: pending.email || null
        }));
        return sendRakenResult({ ok: true });
      } catch (e) {
        console.error('Raken token exchange failed', e);
        return sendRakenResult({ ok: false, error: 'Raken refused the connection. Check the client ID and secret, and that the redirect URI on the Raken app matches this site.' });
      }
    }

    if (url === '/api/raken/disconnect' && req.method === 'POST') {
      const gate = await requireAppManager(req);
      if (gate.error) return sendJSON(res, gate.error, gate.body);
      await store.clearRakenTokens();
      return sendJSON(res, 200, { ok: true });
    }

    // Read-only passthrough, restricted to the four collections this feature
    // uses. An open proxy onto someone's construction-management account is
    // not something to leave lying around, so the allowlist is a prefix match
    // on a fixed list rather than anything clever.
    if (url === '/api/raken/get' && req.method === 'GET') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      if (!raken.isConfigured()) return sendJSON(res, 503, { error: 'raken_not_configured' });
      const q = new URL(req.url, 'https://internal').searchParams;
      const path = q.get('path') || '';
      const allowed = ['/projects', '/dailyReports', '/checklists', '/observations'];
      if (!allowed.some((a) => path === a || path.startsWith(a + '/') || path.startsWith(a + '?'))) {
        return sendJSON(res, 400, { error: 'path_not_allowed', allowed });
      }
      const params = {};
      q.forEach((v, k) => { if (k !== 'path') params[k] = v; });
      try {
        const data = await raken.apiGet(store, path, params);
        return sendJSON(res, 200, data);
      } catch (e) {
        if (e.code === 'not_connected') return sendJSON(res, 409, { error: 'raken_not_connected' });
        console.error('Raken API call failed', e);
        return sendJSON(res, 502, { error: 'raken_error', message: e.message });
      }
    }

    if (url === '/api/blob/delete' && req.method === 'POST') {
      if (!(await store.getSession(getBearerToken(req)))) return sendJSON(res, 401, { error: 'not_authenticated' });
      if (!blob.isConfigured()) return sendJSON(res, 503, { error: 'blob_not_configured' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const pathnames = (Array.isArray(body.pathnames) ? body.pathnames : [])
        .filter((p) => typeof p === 'string' && p)
        .slice(0, 200);
      // Non-fatal by design: the state document has already dropped its
      // reference by the time this is called, so a failed cleanup leaves an
      // orphan, not a broken app.
      let deleted = 0;
      try { deleted = await blob.deleteBlobs(pathnames); }
      catch (e) { console.error('blob delete failed', e); }
      return sendJSON(res, 200, { ok: true, deleted });
    }

    // ---- Microsoft Entra ID (Azure AD) sign-in — identical to the Render
    // build (lib/auth.js is copied over unchanged; it never touched the
    // filesystem, so nothing about it needed to change for Vercel). ----
    if (req.method === 'GET' && url === '/auth/start') {
      const cfg = auth.ssoConfig();
      if (!cfg) { res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return; }
      const { codeVerifier, codeChallenge } = auth.generatePkce();
      const state = crypto.randomBytes(16).toString('hex');
      auth.setCookie(res, 'nucleus_pkce', JSON.stringify({ state, codeVerifier }), { maxAgeSeconds: 600 });
      const authorizeUrl = auth.buildAuthorizeUrl(cfg, { state, codeChallenge });
      res.writeHead(302, Object.assign({ Location: authorizeUrl }, SECURITY_HEADERS));
      res.end();
      return;
    }

    if (req.method === 'GET' && url === '/auth/callback') {
      const cfg = auth.ssoConfig();
      if (!cfg) { res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return; }

      function sendAuthResult(payload) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body>
<script>
(function(){
  var payload = ${JSON.stringify(payload)};
  try {
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      window.close();
    } else if (payload.token) {
      localStorage.setItem('nucleus_auth_token', payload.token);
      location.href = '/';
    } else {
      document.body.textContent = payload.error || 'Sign-in failed. Close this window and try again.';
    }
  } catch (e) {
    document.body.textContent = 'Signed in, but this window could not report back automatically. Close it and reload Nucleus.';
  }
})();
</script>
<p>Signing you in…</p>
</body></html>`;
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
        res.end(html);
      }

      const reqUrl = new URL(req.url, cfg.appBaseUrl);
      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const errorParam = reqUrl.searchParams.get('error');
      const cookies = auth.parseCookies(req);
      auth.clearCookie(res, 'nucleus_pkce');
      let pkce = null;
      try { pkce = JSON.parse(cookies['nucleus_pkce'] || 'null'); } catch (e) { pkce = null; }

      if (errorParam) {
        return sendAuthResult({ type: 'nucleus-auth', error: reqUrl.searchParams.get('error_description') || errorParam });
      }
      if (!code || !returnedState || !pkce || pkce.state !== returnedState) {
        return sendAuthResult({ type: 'nucleus-auth', error: 'Sign-in could not be verified — please try again.' });
      }
      try {
        const tokenResponse = await auth.exchangeCodeForTokens(cfg, { code, codeVerifier: pkce.codeVerifier });
        const claims = await auth.verifyIdToken(cfg, tokenResponse.id_token);
        const email = claims.email || claims.preferred_username || '';
        const name = claims.name || email || 'Unknown';
        const doc = await store.readState();
        const token = await store.issueToken({ type: 'sso', email, name });
        const identity = resolveIdentity({ email, name }, doc.state);
        return sendAuthResult({ type: 'nucleus-auth', token, identity });
      } catch (e) {
        console.error('SSO sign-in failed:', e);
        return sendAuthResult({ type: 'nucleus-auth', error: 'Sign-in failed — please try again, or check with whoever manages Nucleus if this keeps happening.' });
      }
    }

    // ---- Push notifications: subscribe/unsubscribe one browser installation.
    // The public key has nothing to protect (it's handed to every browser
    // that subscribes anyway), so it's readable without signing in — the
    // subscribe/unsubscribe actions themselves still require a real session,
    // since a subscription is tied to one team member. ----
    if (req.method === 'GET' && url === '/api/push/vapid-public-key') {
      if (!vapidKeys) return sendJSON(res, 404, { error: 'push_not_configured' });
      return sendJSON(res, 200, { publicKey: vapidKeys.publicKey });
    }

    if (req.method === 'POST' && url === '/api/push/subscribe') {
      if (!vapidKeys) return sendJSON(res, 404, { error: 'push_not_configured' });
      const identity0 = await store.getSession(getBearerToken(req));
      if (!identity0) return sendJSON(res, 401, { error: 'not_authenticated' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const sub = body && body.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return sendJSON(res, 400, { error: 'bad_subscription' });
      }
      const doc = await store.readState();
      const identity = resolveIdentity(identity0, doc.state);
      await store.addPushSub(sub.endpoint, {
        teamMemberId: identity.teamMemberId,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        userAgent: String((body && body.userAgent) || req.headers['user-agent'] || '').slice(0, 300),
        createdAt: Date.now()
      });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/push/unsubscribe') {
      const identity0 = await store.getSession(getBearerToken(req));
      if (!identity0) return sendJSON(res, 401, { error: 'not_authenticated' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
      const endpoint = body && body.endpoint;
      if (endpoint) await store.removePushSub(endpoint);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Jobs Map: turn one job's typed address into map coordinates via
    // OpenStreetMap's free Nominatim service (see lib/geocode.js — it
    // handles its own caching and the 1-request/second throttle Nominatim's
    // usage policy requires, both in Redis since this function has no
    // reliable memory between invocations). Requires a session, same as
    // everything else that touches job data, even though the address
    // itself isn't sensitive — no reason to let an unauthenticated caller
    // use this server as a free geocoding proxy for something unrelated to
    // Nucleus. ----
    if (req.method === 'GET' && url === '/api/geocode') {
      const identity = await store.getSession(getBearerToken(req));
      if (!identity) return sendJSON(res, 401, { error: 'not_authenticated' });
      const address = new URL(req.url, 'http://internal').searchParams.get('address');
      if (!address || !address.trim()) return sendJSON(res, 400, { error: 'missing_address' });
      try {
        const result = await geocodeAddress(address.trim());
        if (!result) return sendJSON(res, 404, { error: 'not_found' });
        return sendJSON(res, 200, result);
      } catch (e) {
        console.error('Geocode failed:', e);
        return sendJSON(res, 502, { error: 'geocode_failed' });
      }
    }

    if (url === '/data/state.json' || url === '/api/state') {
      const token = getBearerToken(req);
      const identity = await store.getSession(token);
      if (!identity) return sendJSON(res, 401, { error: 'not_authenticated' });

      function resolveRole(state) {
        const member = auth.findRosterMemberByEmail(state, identity.email);
        return member ? member.role : null;
      }

      if (req.method === 'GET') {
        const doc = await store.readState();
        const role = resolveRole(doc.state);
        const outState = roles.filterStateForRole(doc.state, role);
        return sendJSON(res, 200, outState, { 'X-State-Version': String(doc.version) });
      }

      if (req.method === 'POST' && url === '/api/state') {
        let newState;
        try { newState = await readJSONBody(req); }
        catch (e) { return sendJSON(res, e.code === 'too_large' ? 413 : 400, { error: e.code || 'bad_request' }); }
        const clientVersion = Number(req.headers['x-state-version']) || 0;
        const doc = await store.readState();
        const role = resolveRole(doc.state);
        if (clientVersion !== doc.version) {
          const outState = roles.filterStateForRole(doc.state, role);
          return sendJSON(res, 409, { version: doc.version, state: outState });
        }
        const mergedState = roles.reconcileIncomingState(doc.state, newState, role);
        const result = await store.writeStateCAS(clientVersion, mergedState);
        if (!result.ok) {
          // Someone else's save won the race between our version check above
          // and the atomic write — same 409-and-replay contract as a plain
          // version mismatch, just caught one step later.
          const outState = roles.filterStateForRole(result.state, role);
          return sendJSON(res, 409, { version: result.version, state: outState });
        }
        // The state save itself is already committed at this point — a push
        // failure below can never undo or affect it. This IS awaited (unlike
        // the Render build's genuinely fire-and-forget call), because a
        // serverless function's process can be frozen or torn down the
        // moment its response finishes, unlike Render's always-on process —
        // an un-awaited call here could simply never run to completion.
        try {
          await notifyNewPushNotifications(doc.state.notifications || [], mergedState.notifications || []);
        } catch (e) {
          console.error('notifyNewPushNotifications failed:', e);
        }
        try {
          await notifyTeamsChannel(doc.state, mergedState);
        } catch (e) {
          console.error('notifyTeamsChannel failed:', e);
        }
        return sendJSON(res, 200, { version: result.version });
      }
    }

    sendJSON(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('Unhandled router error:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal_error', message: e.message });
  }
};
