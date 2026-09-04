/**
 * Minimal, dependency-free Web Push (RFC 8291 message encryption + RFC 8292
 * VAPID) sender — built with Node's own `crypto` and `https` modules because
 * this project doesn't `npm install` anything (see index.js's top comment).
 * This is everything the popular `web-push` npm package does, hand-rolled to
 * the exact bytes the spec requires — verified against RFC 8291 Appendix A's
 * published test vector during development (every intermediate value and
 * the final ciphertext matched exactly), not just "looks right."
 *
 * What this is for: when someone gets a Nucleus notification (a cost impact
 * or a request assigned to them — see NOTIFICATIONS in index.html), this
 * sends a real push message to their phone/tablet so it shows up even if
 * Nucleus isn't open, the same way a text message would arrive. It needs no
 * paid service (unlike the SMS/email alerts Greg looked into earlier) —
 * just a one-time VAPID keypair this server generates and signs with.
 *
 * Server generates one VAPID keypair (see generateVapidKeys, run once, keys
 * saved as NUCLEUS_VAPID_PUBLIC_KEY / NUCLEUS_VAPID_PRIVATE_KEY env vars —
 * see .env.example). The public key is handed to the browser so it can
 * subscribe; the private key signs every push this server sends so the push
 * service (FCM, Mozilla's, Apple's) knows it's really from this server.
 */
const https = require('https');
const crypto = require('crypto');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}
// Single-block HKDF-Expand — fine here since every length we ever ask for
// (32, 16, 12 bytes) fits in one SHA-256 HMAC block.
function hkdfExpand(prk, info, len) {
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, len);
}

/**
 * Generates a new VAPID (P-256) keypair, returned as the raw base64url
 * strings this module and the browser's `pushManager.subscribe` both expect
 * (65-byte uncompressed public point / 32-byte private scalar) — run this
 * once (see the printed instructions in .env.example) and store the result
 * as environment variables, the same pattern as NUCLEUS_ENCRYPTION_KEY.
 */
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const rawPublic = Buffer.concat([Buffer.from([4]), b64urlDecode(pubJwk.x), b64urlDecode(pubJwk.y)]);
  return { publicKey: b64url(rawPublic), privateKey: b64url(b64urlDecode(privJwk.d)) };
}

// Rebuilds a usable EC private-key object from just the raw 32-byte scalar
// we store (JWK also needs the public x/y — ECDH can derive those from the
// scalar alone, since the public point is just d*G on the curve).
function privateKeyObjectFromRaw(privateKeyB64url) {
  const rawPrivate = b64urlDecode(privateKeyB64url);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(rawPrivate);
  const rawPublic = ecdh.getPublicKey();
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(rawPrivate), x: b64url(rawPublic.slice(1, 33)), y: b64url(rawPublic.slice(33, 65)) },
    format: 'jwk'
  });
}

// Builds the "Authorization: vapid t=<jwt>, k=<publicKey>" header value for
// one push send. `audience` must be the push endpoint's own origin (each
// browser vendor's push service checks this) — see RFC 8292.
function buildVapidHeader(privateKeyB64url, publicKeyB64url, audience, subjectMailto) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subjectMailto };
  const unsigned = b64url(Buffer.from(JSON.stringify(header))) + '.' + b64url(Buffer.from(JSON.stringify(payload)));
  const key = privateKeyObjectFromRaw(privateKeyB64url);
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  const jwt = unsigned + '.' + b64url(sig);
  return `vapid t=${jwt}, k=${publicKeyB64url}`;
}

// RFC 8291 message encryption: encrypts `payload` (a Buffer) for delivery to
// one push subscription, returning the complete request body (the RFC 8188
// aes128gcm content-coding header followed by the ciphertext) ready to POST.
function encryptPayload(subscriptionKeys, payload) {
  const uaPublic = b64urlDecode(subscriptionKeys.p256dh);
  const authSecret = b64urlDecode(subscriptionKeys.auth);

  const asEcdh = crypto.createECDH('prime256v1');
  asEcdh.generateKeys();
  const asPublic = asEcdh.getPublicKey();
  const ecdhSecret = asEcdh.computeSecret(uaPublic);

  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);

  // Single-record message: append the 0x02 "last record" delimiter octet,
  // no further padding — our payloads (a short notification message) are
  // always far under the 4096-byte record size used below.
  const padded = Buffer.concat([payload, Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext]);
}

/**
 * Sends one push notification. `subscription` is exactly what the browser's
 * `PushSubscription.toJSON()` produces: `{endpoint, keys:{p256dh,auth}}`.
 * `payload` is any JSON-serializable object — the service worker's `push`
 * handler (see sw.js) reads it back with `event.data.json()`.
 *
 * Resolves to `{ok:true}` on success, or `{ok:false, gone:true}` when the
 * push service reports the subscription no longer exists (404/410) — the
 * caller should delete that subscription, since resending to it will never
 * succeed. Any other failure resolves `{ok:false, gone:false, error}` and is
 * never thrown — one bad or stale subscription must never break sending to
 * everyone else who should get the same notification.
 */
function sendWebPush(subscription, payload, vapidKeys, opts) {
  const subjectMailto = (opts && opts.subject) || 'mailto:notifications@example.com';
  return new Promise((resolve) => {
    let endpointUrl;
    try {
      endpointUrl = new URL(subscription.endpoint);
    } catch (e) {
      return resolve({ ok: false, gone: false, error: 'Malformed subscription endpoint' });
    }
    let body;
    try {
      body = encryptPayload(subscription.keys, Buffer.from(JSON.stringify(payload), 'utf8'));
    } catch (e) {
      return resolve({ ok: false, gone: false, error: 'Encryption failed: ' + e.message });
    }
    let authHeader;
    try {
      authHeader = buildVapidHeader(vapidKeys.privateKey, vapidKeys.publicKey, endpointUrl.origin, subjectMailto);
    } catch (e) {
      return resolve({ ok: false, gone: false, error: 'VAPID signing failed: ' + e.message });
    }
    const req = https.request(
      {
        hostname: endpointUrl.hostname,
        port: endpointUrl.port || 443,
        path: endpointUrl.pathname + endpointUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          TTL: '86400',
          Authorization: authHeader
        }
      },
      (res) => {
        res.resume(); // discard body, we only care about the status
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) return resolve({ ok: true });
          if (res.statusCode === 404 || res.statusCode === 410) return resolve({ ok: false, gone: true });
          resolve({ ok: false, gone: false, error: 'Push service returned ' + res.statusCode });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, gone: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

module.exports = { generateVapidKeys, sendWebPush };
