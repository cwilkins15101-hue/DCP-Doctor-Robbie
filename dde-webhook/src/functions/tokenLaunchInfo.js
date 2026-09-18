// Called by the Doctor Robbie app right before it launches Dragon
// Copilot's own web UI via the Token Launch API. Mints a short-lived
// partner access token server-side (needs the Entra client secret, which
// the app itself never holds) and hands back the Microsoft-assigned
// partner/org/product/EHR identifiers the launch form needs — those only
// live in this server's .env, not the app's.
const { app } = require('@azure/functions');
const config = require('../lib/config');
const { getConnectorAccessToken } = require('../lib/dragonApiAuth');
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
    const accessToken = await getConnectorAccessToken();
    return withCors({
      status: 200,
      jsonBody: {
        accessToken,
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
