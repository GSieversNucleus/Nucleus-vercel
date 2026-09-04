/**
 * Minimal, dependency-free JWT (RS256) verification against a JWKS endpoint —
 * built with Node's own `crypto` module because this project doesn't
 * `npm install` anything. Used to verify Microsoft Entra ID (Azure AD)
 * ID tokens after the OAuth2 authorization-code exchange.
 *
 * This intentionally does the minimum a correct verifier must do, and no
 * more — it does NOT trust anything the token itself claims about how to
 * verify it:
 *   - The signing algorithm is hard-coded to RS256. The token's own `alg`
 *     header is checked against that fixed expectation, never used to pick
 *     the verification method — accepting whatever `alg` a token claims
 *     (including "none") is the classic JWT signature-bypass bug.
 *   - The key used to verify comes from the issuer's published JWKS,
 *     matched by `kid`, never from the token itself.
 *   - iss / aud / exp / nbf are all checked against expected values, not
 *     just "does it parse."
 */
const crypto = require('crypto');

function base64urlToBuffer(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Small in-memory JWKS cache per issuer, so we're not fetching Microsoft's
// keys on every single login. Keys rotate rarely; a day is a safe TTL, and
// a cache miss (unknown kid) always forces one fresh re-fetch before giving
// up, so a real rotation is never permanently missed.
const jwksCache = new Map(); // jwksUri -> { keys, fetchedAt }
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchJwks(jwksUri, { force } = {}) {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`Could not fetch JWKS (${res.status})`);
  const body = await res.json();
  const keys = body.keys || [];
  jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

async function getPublicKeyForKid(jwksUri, kid) {
  let keys = await fetchJwks(jwksUri);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    // Might be a genuine key rotation — re-fetch once, bypassing the cache,
    // before treating this as an unknown/untrusted key.
    keys = await fetchJwks(jwksUri, { force: true });
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('No matching key found in JWKS for this token');
  if (jwk.kty !== 'RSA') throw new Error('Unsupported key type in JWKS: ' + jwk.kty);
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

/**
 * Verifies an RS256 JWT's signature and standard timing/audience/issuer
 * claims. Returns the decoded payload on success; throws a descriptive
 * Error on any failure. `expected` is required and must specify `iss` and
 * `aud` — this function never infers what a token "should" have claimed.
 */
async function verifyJwt(token, jwksUri, expected) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token (not three parts)');
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64urlToBuffer(headerB64).toString('utf8'));
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  } catch (e) {
    throw new Error('Malformed token (bad JSON in header/payload)');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unexpected token algorithm "${header.alg}" — only RS256 is accepted`);
  }

  const key = await getPublicKeyForKid(jwksUri, header.kid);
  const signedInput = `${headerB64}.${payloadB64}`;
  const signature = base64urlToBuffer(sigB64);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(signedInput, 'utf8'), key, signature);
  if (!ok) throw new Error('Signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 120; // seconds of tolerance for clock drift between servers
  if (typeof payload.exp !== 'number' || now > payload.exp + clockSkew) {
    throw new Error('Token has expired');
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf - clockSkew) {
    throw new Error('Token is not valid yet');
  }
  if (expected.iss && payload.iss !== expected.iss) {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  if (expected.aud && payload.aud !== expected.aud) {
    throw new Error(`Unexpected audience: ${payload.aud}`);
  }
  if (expected.tid && payload.tid !== expected.tid) {
    throw new Error(`Unexpected tenant id: ${payload.tid}`);
  }

  return payload;
}

module.exports = { verifyJwt, base64url, base64urlToBuffer };
