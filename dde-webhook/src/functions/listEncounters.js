// Lists a physician's recent encounters for cross-device history
// (2026-09-25) — GET /api/listEncounters?externalUserId=... Only returns
// what recordEncounter.js indexed (correlationId, patient, startedAt);
// the app fetches each encounter's actual note/transcript/form output
// separately via the existing getResult, same as it always has.
const { app } = require('@azure/functions');
const config = require('../lib/config');
const storage = require('../lib/storage');
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

  const externalUserId = request.query.get('externalUserId');
  if (!externalUserId) {
    return withCors({ status: 400, body: 'externalUserId query parameter is required.' });
  }

  let encounters;
  try {
    encounters = await storage.listEncounters(externalUserId);
  } catch (err) {
    context.error(`listEncounters failed for externalUserId ${externalUserId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  return withCors({ status: 200, jsonBody: { encounters } });
}

app.http('listEncounters', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'listEncounters',
  handler,
});

module.exports = { handler };
