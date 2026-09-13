// One-time (or re-run when updating) script to register Doctor Robbie's
// webhook with Dragon Data Exchange. Matches the exact contract from
// Microsoft's "Provision a webhook" documentation.
//
// Usage:
//   node scripts/provisionWebhook.js
//
// Reads all values from environment variables (see .env.example in this
// folder) so nothing sensitive is hardcoded here.

require('dotenv').config();
const { ClientSecretCredential } = require('@azure/identity');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const tenantId = requiredEnv('ENTRA_TENANT_ID');
  const clientId = requiredEnv('ENTRA_CLIENT_ID');
  const clientSecret = requiredEnv('ENTRA_CLIENT_SECRET');
  const scope = process.env.DRAGON_API_SCOPE || '105be974-d66d-43c9-b813-57a967bbfd21/.default';
  const baseUrl = requiredEnv('DRAGON_API_BASE_URL'); // e.g. https://partnerapi-qa.ppe.copilot.dragon.com

  const partnerId = requiredEnv('DRAGON_PARTNER_GUID');
  const customerId = requiredEnv('DRAGON_ENVIRONMENT_ID'); // "customerId" in DDE's terms
  const productId = process.env.DRAGON_PRODUCT_ID || '4f939ade-287a-416d-8484-1e64013039dd';
  const webHookUrl = requiredEnv('WEBHOOK_URL'); // your deployed Azure Function's dde-webhook URL
  const webhookSharedSecret = requiredEnv('WEBHOOK_SHARED_SECRET');

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const token = await credential.getToken(scope);

  const subscriptionRequest = {
    partnerId,
    customerId,
    productId,
    webHookUrl,
    eventFamily: ['dax'],
    // Simplest of the three documented security options — a shared
    // secret appended to the webhook URL as ?access_token=... on every
    // delivery. Must match WEBHOOK_SHARED_SECRET the Function reads.
    accessToken: webhookSharedSecret,
  };

  const url = `${baseUrl}/subscriptions?api-version=2&customerId=${encodeURIComponent(customerId)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token.token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(subscriptionRequest),
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error(`Provisioning failed: ${response.status}`);
    console.error(responseText);
    process.exit(1);
  }

  console.log(`Success (HTTP ${response.status}):`);
  console.log(responseText);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
