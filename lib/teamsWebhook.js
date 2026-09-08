/**
 * Posts a plain-text line into a Microsoft Teams channel via that channel's
 * "Workflows" webhook (Teams' current replacement for the old, now-retired
 * Office 365 Connectors — Microsoft added a compatibility shim in Feb 2026
 * so a simple `{text: "..."}` POST body still works against the new
 * Workflows webhook URL, same as it did against the old connector URL).
 * Greg creates the webhook himself from inside the target Teams channel
 * (channel "..." menu -> Workflows -> "Post to a channel when a webhook
 * request is received" template) and sets the URL it gives him as the
 * NUCLEUS_TEAMS_WEBHOOK_URL environment variable in Vercel's project
 * settings — see .env.example. Missing that env var just means this
 * feature is inactive; nothing else about the app depends on it, same
 * "optional, best-effort" contract as webpush.js's VAPID keys.
 *
 * Zero external dependencies, same as the rest of this build's server-side
 * code (geocode.js/webpush.js) — a plain https.request.
 */
const https = require('https');

function postToTeamsWebhook(webhookUrl, text) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(webhookUrl); }
    catch (e) { return resolve({ ok: false, error: 'invalid_webhook_url' }); }
    const body = JSON.stringify({ text });
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        // Drain the response so the socket can close; the body isn't needed.
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
          else resolve({ ok: false, error: `teams webhook returned ${res.statusCode}` });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(8000, () => req.destroy(new Error('Teams webhook request timed out')));
    req.write(body);
    req.end();
  });
}

module.exports = { postToTeamsWebhook };
