#!/usr/bin/env node
/**
 * Run this once (locally, with Node — not as part of a Vercel deploy) to
 * turn on push notifications:
 *
 *   node generate-vapid-keys.js
 *
 * It prints two environment variables. Add both to this project's Vercel
 * Settings → Environment Variables (see .env.example), then redeploy (or
 * just wait for the next deploy — env var changes apply to new deployments).
 * Do this once per deployment, not once per person — every team member's
 * browser subscribes against this same keypair. See README.md ("Push
 * notifications").
 *
 * These two keys are NOT secret from browsers (the public one is handed to
 * every subscribing device) but the PRIVATE key must be kept as secret as
 * NUCLEUS_ENCRYPTION_KEY — anyone who has it could send push messages that
 * claim to come from this deployment.
 */
const webpush = require('./lib/webpush');
const keys = webpush.generateVapidKeys();
console.log('\nAdd these two lines to your Vercel project\'s environment variables, then redeploy:\n');
console.log('NUCLEUS_VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('NUCLEUS_VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('');
