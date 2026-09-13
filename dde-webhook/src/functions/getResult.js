const { app } = require('@azure/functions');
const config = require('../lib/config');
const { getResult } = require('../lib/storage');
const { handleCorsPreflight, withCors } = require('../lib/cors');

// Polled by the Doctor Robbie app: GET /api/getResult?correlationId=...
// Returns the stored transcript/note data once Dragon Copilot has
// delivered it via the webhook, or 202 while still waiting.
async function handler(request, context) {
  const preflight = handleCorsPreflight(request);
  if (preflight) {
    return preflight;
  }

  const providedSecret = request.headers.get('x-app-secret');
  if (providedSecret !== config.appSharedSecret()) {
    return withCors({ status: 401, body: 'Unauthorized' });
  }

  const correlationId = request.query.get('correlationId');
  if (!correlationId) {
    return withCors({ status: 400, body: 'correlationId query parameter is required.' });
  }

  const result = await getResult(correlationId);
  if (!result) {
    return withCors({ status: 202, jsonBody: { status: 'pending' } });
  }
  return withCors({ status: 200, jsonBody: { status: 'ready', ...result } });
}

app.http('getResult', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'getResult',
  handler,
});

module.exports = { handler };
