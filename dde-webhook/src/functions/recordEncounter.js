// Indexes a new (or continuing) encounter for cross-device history
// (2026-09-25) — called by the app right when a correlationId is first
// assigned, regardless of which submission path (live SDK recording,
// manual file upload, native batch) it ends up going out through. Lets a
// physician signed in on a different device see an encounter they started
// elsewhere. Doesn't touch the actual note/transcript/form output at all
// -- that's still stored separately via the existing webhook + getResult.
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

  let body;
  try {
    body = await request.json();
  } catch {
    return withCors({ status: 400, body: 'Expected a JSON body.' });
  }

  const { correlationId, externalUserId, patient } = body || {};
  if (!correlationId) {
    return withCors({ status: 400, body: 'correlationId is required.' });
  }
  if (!externalUserId) {
    return withCors({ status: 400, body: 'externalUserId is required.' });
  }

  try {
    await storage.saveEncounter(externalUserId, correlationId, patient);
  } catch (err) {
    context.error(`recordEncounter failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  return withCors({ status: 200, jsonBody: { correlationId } });
}

app.http('recordEncounter', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'recordEncounter',
  handler,
});

module.exports = { handler };
