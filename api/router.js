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

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB — matches the app's own MAX_STATE_BYTES headroom

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
        return sendJSON(res, 200, { version: result.version });
      }
    }

    sendJSON(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('Unhandled router error:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal_error', message: e.message });
  }
};
