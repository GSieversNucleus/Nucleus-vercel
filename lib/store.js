/**
 * Redis-backed persistence for the Vercel build of Nucleus.
 *
 * WHY THIS FILE EXISTS AT ALL (read this before touching it): the Render
 * build (nucleus-pwa) is one always-on Node process that keeps its data as
 * files on a persistent disk, plus a few things in plain in-memory Maps
 * (sessions, users, login-rate-limit counters, a write lock). Vercel doesn't
 * work that way — a serverless function has no local disk that survives
 * between requests, and there's no guarantee two requests even land on the
 * same running instance, so in-memory Maps are not reliable storage either.
 * Everything that used to be "a file on disk" or "a Map that stays around"
 * had to move into a real external store — here, Redis via the Upstash
 * Marketplace integration (see README.md, "Storage: Upstash for Redis").
 *
 * Kept identical to the Render build: the AES-256-GCM encrypted-envelope
 * format (so NUCLEUS_ENCRYPTION_KEY works exactly the same way and the
 * data itself is unreadable to anyone without that key, whether they're
 * looking at a Redis backup or Vercel's own dashboard), the scrypt password
 * hashing, and the same {version, state} document shape.
 *
 * Changed from the Render build, and why:
 *   - The in-process write lock (serializing two near-simultaneous saves)
 *     doesn't mean anything across separate serverless invocations. Its job
 *     — never silently let one save clobber another — is done here instead
 *     with a real atomic compare-and-swap, run as a Redis Lua script
 *     (writeStateCAS below), so the "someone else saved first" 409 the app
 *     already knows how to handle keeps working exactly the same way, just
 *     enforced by Redis instead of by staying in one process.
 *   - Login rate-limiting moved from an in-memory Map to Redis INCR/EXPIRE
 *     per IP, for the same reason — an in-memory counter would silently
 *     reset itself whenever a request happened to land on a fresh instance.
 *   - A decrypt failure (wrong/missing NUCLEUS_ENCRYPTION_KEY on data that
 *     IS encrypted) throws instead of calling process.exit(1). The Render
 *     build could afford to hard-exit — that's one whole server refusing to
 *     serve anything until someone fixes the key. A serverless function
 *     can't "stay down" the same way, so this throws a clear error instead,
 *     which the router turns into a loud 500 with the same warning in the
 *     logs — still a hard failure, still never silently starts from empty,
 *     just scoped to the one request instead of the whole process.
 */
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

// ---- Key names — everything Nucleus stores lives under one "nucleus:" prefix
// so it's easy to find (or wipe, if you ever needed to) inside the Redis
// store's own data browser, without touching anything else that might
// someday share the same database. ----
const K_STATE_VERSION = 'nucleus:state:version'; // plain integer, NOT encrypted — read on every save to compare-and-swap
const K_STATE_DOC = 'nucleus:state:doc'; // encrypted envelope of the full {version, state} document
const K_USERS = 'nucleus:users'; // encrypted envelope of { email: {passwordHash, updatedAt} }
const K_SESSIONS = 'nucleus:sessions'; // encrypted envelope of { token: {issuedAt, auth} }
const K_BACKUPS = 'nucleus:backups'; // Redis list, newest first, capped at MAX_BACKUPS
const MAX_BACKUPS = 30;
const RATE_PREFIX = 'nucleus:loginrate:'; // + ip -> integer count, TTL'd

// ---- Encryption at rest — identical scheme to the Render build. ----
const ENC_KEY_HEX = process.env.NUCLEUS_ENCRYPTION_KEY || '';
let ENC_KEY = null;
if (ENC_KEY_HEX) {
  if (!/^[0-9a-fA-F]{64}$/.test(ENC_KEY_HEX)) {
    throw new Error(
      "NUCLEUS_ENCRYPTION_KEY is set but isn't 64 hex characters (32 bytes). Generate one with: " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  ENC_KEY = Buffer.from(ENC_KEY_HEX, 'hex');
}
function encryptEnvelope(obj) {
  if (!ENC_KEY) return JSON.stringify(obj);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ enc: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') });
}
function decryptEnvelope(raw, fallback) {
  if (raw == null) return fallback;
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fallback; }
  if (parsed && parsed.enc === 1) {
    if (!ENC_KEY) {
      throw new Error(
        'This data is encrypted, but NUCLEUS_ENCRYPTION_KEY is not set. Set the exact same key that ' +
        "was used to write it — the data isn't gone, it's just unreadable without that key."
      );
    }
    try {
      const iv = Buffer.from(parsed.iv, 'base64');
      const tag = Buffer.from(parsed.tag, 'base64');
      const ct = Buffer.from(parsed.ct, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    } catch (e) {
      throw new Error('Could not decrypt this data with the current NUCLEUS_ENCRYPTION_KEY — either the key is wrong or the data is corrupted.');
    }
  }
  // Legacy/plain JSON (NUCLEUS_ENCRYPTION_KEY not set) — read as-is; the next
  // successful write upgrades it to the encrypted format.
  return parsed;
}

// ---- State document: {version, state}. version is kept as its own plain
// (unencrypted — it's just a counter, not app data) Redis key so the
// compare-and-swap below can check it without paying for a decrypt on every
// attempt. ----
async function readState() {
  const [versionRaw, docRaw] = await Promise.all([
    redis.get(K_STATE_VERSION),
    redis.get(K_STATE_DOC)
  ]);
  if (docRaw == null) return { version: 0, state: {} };
  const doc = decryptEnvelope(docRaw, { version: 0, state: {} });
  // The plain version counter is the source of truth for compare-and-swap;
  // fall back to the document's own version if the counter key is somehow
  // missing (shouldn't happen outside a brand new, never-saved database).
  const version = versionRaw != null ? Number(versionRaw) : (doc.version || 0);
  return { version, state: doc.state || {} };
}

// Atomic compare-and-swap: only writes if the version stored in Redis right
// now still matches expectedVersion — otherwise nothing is written, and the
// caller gets back what's actually there so it can tell the client "someone
// else saved first" (the same 409-and-replay behavior the Render build has
// always had). This is what keeps two near-simultaneous saves from one
// silently clobbering the other now that there's no single process left to
// serialize them with an in-memory lock.
const CAS_SCRIPT = `
local verKey = KEYS[1]
local docKey = KEYS[2]
local expected = tonumber(ARGV[1])
local newVersion = ARGV[2]
local newDoc = ARGV[3]
local cur = tonumber(redis.call('GET', verKey) or '0')
if cur == expected then
  redis.call('SET', verKey, newVersion)
  redis.call('SET', docKey, newDoc)
  return 1
else
  return 0
end
`;
async function writeStateCAS(expectedVersion, nextState) {
  const nextVersion = expectedVersion + 1;
  const envelope = encryptEnvelope({ version: nextVersion, state: nextState });
  const result = await redis.eval(CAS_SCRIPT, [K_STATE_VERSION, K_STATE_DOC], [String(expectedVersion), String(nextVersion), envelope]);
  if (Number(result) === 1) {
    await writeBackup(nextVersion, envelope);
    return { ok: true, version: nextVersion, state: nextState };
  }
  // Someone else won the race — return the current, real state so the
  // caller can hand it back to the client for a replay-and-retry.
  const current = await readState();
  return { ok: false, version: current.version, state: current.state };
}

// Rolling backups — a Redis list, newest pushed to the front, trimmed to the
// last MAX_BACKUPS. Same safety-net purpose as the Render build's backups/
// folder: a bad deploy, a mistaken bulk edit, or (new to this build) an
// Upstash-side incident shouldn't be able to erase history with no way back.
// Best-effort: if this fails, the real save above has already succeeded.
async function writeBackup(version, envelope) {
  try {
    const entry = JSON.stringify({ version, at: new Date().toISOString(), envelope });
    await redis.lpush(K_BACKUPS, entry);
    await redis.ltrim(K_BACKUPS, 0, MAX_BACKUPS - 1);
  } catch (e) {
    console.error('Could not write a backup snapshot (the real save still succeeded):', e);
  }
}
async function listBackups() {
  const raw = await redis.lrange(K_BACKUPS, 0, MAX_BACKUPS - 1);
  return raw.map((r) => {
    try { const parsed = typeof r === 'string' ? JSON.parse(r) : r; return { version: parsed.version, at: parsed.at }; }
    catch (e) { return null; }
  }).filter(Boolean);
}

// ---- Accounts (users.json equivalent) ----
async function loadUsers() {
  const raw = await redis.get(K_USERS);
  return decryptEnvelope(raw, {});
}
async function saveUsers(users) {
  await redis.set(K_USERS, encryptEnvelope(users));
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || stored.indexOf(':') === -1) return false;
  const [saltHex, hashHex] = stored.split(':');
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
async function setUserPassword(email, password) {
  const key = normalizeEmail(email);
  const users = await loadUsers();
  users[key] = { passwordHash: hashPassword(password), updatedAt: Date.now() };
  await saveUsers(users);
}
async function findUser(email) {
  const users = await loadUsers();
  return users[normalizeEmail(email)] || null;
}

// One-time-per-cold-start admin bootstrap — see api/router.js for where this
// is called. Mirrors the Render build's "re-syncs on every restart": here,
// "restart" is a fresh serverless instance rather than a fresh process, but
// the intent (your own login always matches these two env vars) is the same.
async function bootstrapAdminAccount() {
  const email = process.env.NUCLEUS_ADMIN_EMAIL || '';
  const password = process.env.NUCLEUS_ADMIN_PASSWORD || '';
  if (!email || !password) return;
  await setUserPassword(email, password);
}

// ---- Sessions (sessions.json equivalent) ----
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
async function loadSessions() {
  const raw = await redis.get(K_SESSIONS);
  const obj = decryptEnvelope(raw, {});
  // Drop anything without a real auth.email — same legacy-session cleanup
  // the Render build does.
  const out = {};
  Object.entries(obj || {}).forEach(([token, value]) => {
    if (value && value.auth && value.auth.email) out[token] = value;
  });
  return out;
}
async function saveSessions(sessions) {
  await redis.set(K_SESSIONS, encryptEnvelope(sessions));
}
async function issueToken(authInfo) {
  const token = crypto.randomBytes(24).toString('hex');
  const sessions = await loadSessions();
  sessions[token] = { issuedAt: Date.now(), auth: authInfo };
  await saveSessions(sessions);
  return token;
}
async function getSession(token) {
  if (!token) return null;
  const sessions = await loadSessions();
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() - session.issuedAt > SESSION_TTL_MS) {
    delete sessions[token];
    await saveSessions(sessions);
    return null;
  }
  return session.auth;
}
async function deleteSession(token) {
  if (!token) return;
  const sessions = await loadSessions();
  if (sessions[token]) {
    delete sessions[token];
    await saveSessions(sessions);
  }
}

// ---- Login rate limiting — Redis INCR + EXPIRE per IP, replacing the
// Render build's in-memory sliding window. A fixed window (not sliding) is
// a deliberate simplification: it's still a real speed bump against
// brute-forcing a password, which is all this was ever meant to be (see
// server/index.js's own comment on this in the Render build) — not an
// audit log or a defense against a determined, distributed attacker. ----
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
async function isRateLimited(ip) {
  const count = await redis.get(RATE_PREFIX + ip);
  return Number(count || 0) >= LOGIN_MAX_ATTEMPTS;
}
async function recordFailedLogin(ip) {
  const key = RATE_PREFIX + ip;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
}

module.exports = {
  readState,
  writeStateCAS,
  listBackups,
  loadUsers,
  setUserPassword,
  findUser,
  verifyPassword,
  normalizeEmail,
  bootstrapAdminAccount,
  issueToken,
  getSession,
  deleteSession,
  isRateLimited,
  recordFailedLogin,
  MIN_PASSWORD_LEN: 8
};
