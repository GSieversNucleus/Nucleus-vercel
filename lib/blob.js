/**
 * Attachment storage that lives OUTSIDE the state document.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nucleus persists by POSTing its ENTIRE state document to /api/state on
 * every save. Attachments used to be inlined into that document as base64
 * `dataUrl` strings, which meant the sum of every photo and PDF ever attached
 * had to fit inside one HTTP request. Vercel rejects a request body over
 * ~4.5MB with a 413 before any application code runs, so attaching ~5MB of
 * elevation sheets broke saving for the whole app until they were removed.
 * Measured directly against the live deployment on 2026-09-18:
 *
 *     3.0MB -> 409 (accepted, rejected on CAS)   4.4MB -> 413
 *     4.0MB -> 409                               6.0MB -> 413
 *
 * See claude/nucleus-storage-ceiling-finding.md in the project for the full
 * write-up.
 *
 * THE FIX
 * -------
 * Files go straight from the browser to a private Vercel Blob store and never
 * pass through a function at all, so the 4.5MB request cap stops applying to
 * them. The state document keeps only a small descriptor:
 *
 *     { name, size, type, pathname }     <- new
 *     { name, size, dataUrl }            <- legacy, still rendered as-is
 *
 * Both shapes coexist forever. Nothing migrates, nothing breaks.
 *
 * HOW THE BROWSER TALKS TO THE STORE
 * ----------------------------------
 * The store is PRIVATE, so its URLs are not publicly readable. Rather than
 * streaming bytes back through a function (which would put every photo in the
 * app on the function's data path), this module mints short-lived *presigned*
 * URLs:
 *
 *   - upload: the browser asks for a presigned PUT URL, then does a plain
 *     `fetch(url, {method:'PUT', body:file})`. No SDK in the browser — the
 *     app is a single hand-written HTML file with no build step, so a
 *     bundled npm client was never an option.
 *   - read:   the browser asks for presigned GET URLs in a batch and drops
 *     them straight into <img src> / <a href>. They are CDN-cacheable.
 *
 * `issueSignedToken()` is the only call that hits Vercel's control API; the
 * resulting delegation is cached in module scope (warm lambdas reuse it) and
 * `presignUrl()` is pure local HMAC after that. So signing 40 photo URLs for
 * one page render costs zero extra network round-trips.
 *
 * The @vercel/blob import is DYNAMIC on purpose: this router is CommonJS, and
 * `await import()` works whether the package resolves to CJS or ESM.
 */
const crypto = require('crypto');

// Single-file cap. Generous enough for a full-size elevation sheet or a
// phone photo, small enough that one bad upload can't quietly cost real
// money. Enforced twice: embedded in the delegation payload (so the CDN
// rejects an oversized PUT even with a valid URL) and re-checked in the
// route before a URL is ever issued.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// A PUT URL only has to survive one upload; a GET URL has to survive a page
// somebody left open over lunch. Both are capped by the delegation's own
// lifetime.
const PUT_URL_TTL_MS = 15 * 60 * 1000;
const GET_URL_TTL_MS = 4 * 60 * 60 * 1000;
const DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;
const DELEGATION_MARGIN_MS = 10 * 60 * 1000;

// Blobs are immutable once written (every pathname carries a uuid), so the
// CDN can hold them for a year.
const CACHE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

let sdkPromise = null;
function sdk() {
  if (!sdkPromise) {
    sdkPromise = import('@vercel/blob').then((m) => {
      // Interop: a CJS build can land under .default depending on how the
      // runtime resolves it. Pick whichever object actually has the methods.
      if (m && typeof m.issueSignedToken === 'function') return m;
      if (m && m.default && typeof m.default.issueSignedToken === 'function') return m.default;
      return m;
    });
  }
  return sdkPromise;
}

// Vercel injects these when the Blob store is connected to the project. With
// neither one present (a local run, or the connection removed), the app falls
// back to the old inline-dataUrl path instead of erroring — see the client's
// uploadAttachment().
function isConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

// One delegation per operation, reused until it's near expiry.
const delegations = Object.create(null);
async function delegationFor(operation) {
  const cached = delegations[operation];
  if (cached && cached.validUntil - Date.now() > DELEGATION_MARGIN_MS) return cached;
  const { issueSignedToken } = await sdk();
  const opts = {
    pathname: '*',
    operations: [operation],
    validUntil: Date.now() + DELEGATION_TTL_MS
  };
  if (operation === 'put') opts.maximumSizeInBytes = MAX_FILE_BYTES;
  const token = await issueSignedToken(opts);
  delegations[operation] = token;
  return token;
}

/**
 * Where a file lands in the store. Generated on the SERVER so a client can't
 * choose its own path (and so two people attaching "photo.jpg" at the same
 * moment can't collide). The uuid makes the pathname unguessable on its own,
 * which matters because a presigned URL is the only other thing guarding it.
 * The original filename is preserved at the end purely so the Vercel dashboard
 * and a browser's "Save as" show something recognisable.
 */
function makePathname(name) {
  const safe = String(name || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+/, '')
    .slice(-80) || 'file';
  const day = new Date().toISOString().slice(0, 10);
  return `nucleus/${day}/${crypto.randomUUID()}-${safe}`;
}

async function signUpload(pathname) {
  const { presignUrl } = await sdk();
  const token = await delegationFor('put');
  const validUntil = Date.now() + PUT_URL_TTL_MS;
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'private',
    maximumSizeInBytes: MAX_FILE_BYTES,
    addRandomSuffix: false,   // the uuid above already guarantees uniqueness,
    allowOverwrite: false,    // and nothing may ever overwrite an existing blob
    cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
    validUntil
  });
  return { uploadUrl: presignedUrl, expiresAt: validUntil };
}

/**
 * Batch-signs read URLs for one render pass. A single bad pathname (a file
 * deleted out from under the state document, say) must not take the whole
 * batch down with it, so failures are skipped and simply come back missing —
 * the client renders those as an unavailable-file chip.
 */
async function signReads(pathnames) {
  const { presignUrl } = await sdk();
  const token = await delegationFor('get');
  const validUntil = Date.now() + GET_URL_TTL_MS;
  const urls = Object.create(null);
  for (const pathname of pathnames) {
    try {
      const { presignedUrl } = await presignUrl(token, {
        operation: 'get',
        pathname,
        access: 'private',
        validUntil
      });
      urls[pathname] = presignedUrl;
    } catch (e) {
      console.warn('blob: could not sign read for', pathname, '-', e && e.message);
    }
  }
  return { urls, expiresAt: validUntil };
}

/**
 * Best-effort cleanup when an attachment is removed from the app. A failure
 * here is deliberately non-fatal: the state document has already dropped its
 * reference, so the worst case is an orphaned blob costing a fraction of a
 * cent, which is far better than blocking someone from deleting a photo.
 */
async function deleteBlobs(pathnames) {
  const { presignUrl } = await sdk();
  const token = await delegationFor('delete');
  let deleted = 0;
  for (const pathname of pathnames) {
    try {
      const { presignedUrl } = await presignUrl(token, {
        operation: 'delete',
        pathname,
        access: 'private'
      });
      const res = await fetch(presignedUrl, { method: 'DELETE' });
      if (res.ok) deleted++;
      else console.warn('blob: delete returned', res.status, 'for', pathname);
    } catch (e) {
      console.warn('blob: delete failed for', pathname, '-', e && e.message);
    }
  }
  return deleted;
}

module.exports = {
  MAX_FILE_BYTES,
  GET_URL_TTL_MS,
  isConfigured,
  makePathname,
  signUpload,
  signReads,
  deleteBlobs
};
