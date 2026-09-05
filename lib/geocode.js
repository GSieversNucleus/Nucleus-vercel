/**
 * Address -> {lat, lng} geocoding for the Jobs Map, via OpenStreetMap's free
 * Nominatim service (https://nominatim.org) — no API key, no signup, no
 * ongoing cost. Same contract as the Render build's server/geocode.js, but
 * adapted the same way everything else in this build is: a serverless
 * function has no reliable in-memory state between invocations, so both the
 * results cache and the "never call more than once a second" throttle
 * Nominatim's usage policy requires live in Redis (see the geocode
 * functions in store.js) instead of a module-level Map/variable.
 */
const https = require('https');
const store = require('./store');

const MIN_INTERVAL_MS = 1100; // Nominatim's usage policy: max 1 request/second

function normalize(address) {
  return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // Required by Nominatim's usage policy — a real identifier for
          // this specific tool, not a generic/browser User-Agent.
          'User-Agent': 'Nucleus-CommandCenter/1.0 (internal job-tracking tool for C/S Erectors)'
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Nominatim returned ${res.statusCode}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Nominatim request timed out')));
  });
}

async function geocodeAddress(address) {
  const key = normalize(address);
  if (!key) return null;

  const cached = await store.getGeocodeCacheEntry(key);
  if (cached) return cached;

  const lastCallAt = await store.getGeocodeLastCallAt();
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
  if (wait > 0) await sleep(wait);
  await store.setGeocodeLastCallAt(Date.now());

  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(address);
  const results = await httpsGetJson(url);
  if (!Array.isArray(results) || results.length === 0) return null;

  const hit = results[0];
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;

  const result = { lat, lng, displayName: hit.display_name || address };
  await store.setGeocodeCacheEntry(key, result);
  return result;
}

module.exports = { geocodeAddress };
