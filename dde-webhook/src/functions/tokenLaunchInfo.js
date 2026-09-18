// Called by the Doctor Robbie app right before it launches Dragon
// Copilot's own web UI via the Token Launch API. Hands back the
// Microsoft-assigned partner/org/product/EHR identifiers the launch form
// needs — those only live in this server's .env, not the app's. The
// actual accessToken for that call is NOT minted here — it comes from the
// physician's own delegated Microsoft sign-in in the app (msftAuth.js).
// Token Launch rejects a server-minted app-only token outright (confirmed
// via a live 401 from Dragon Copilot), so this endpoint only ever handles
// plain identifiers, never a credential.
const { app } = require('@azure/functions');
const config = require('../lib/config');
const { handleCorsPreflight, withCors } = require('../lib/cors');

async function handler(request, context) {
  const preflight = handleCorsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const providedSecret = request.headers.get('x-app-secret');
  if (providedSecret !== config.appSharedSecret()) {
    return withCors({ status: 401, body: 'Unauthorized' });
  }

  try {
    return withCors({
      status: 200,
      jsonBody: {
        partnerId: config.dragonPartnerGuid(),
        orgId: config.dragonEnvironmentId(),
        productId: config.dragonProductId(),
        clientName: config.dragonClientName(),
        ehr: config.dragonEhrId(),
        ehrBaseUrl: config.dragonEhrBaseUrl(),
      },
    });
  } catch (err) {
    context.error('tokenLaunchInfo failed:', err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }
}

app.http('tokenLaunchInfo', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'tokenLaunchInfo',
  handler,
});

module.exports = { handler };
