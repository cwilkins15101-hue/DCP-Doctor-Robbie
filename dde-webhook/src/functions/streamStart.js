// First call of the live-streaming flow (web only, 2026-09-24) — creates
// the ambient session (REST) and opens the AAS WebSocket, sending
// RecordingOpen. The app awaits this call's success before it starts
// capturing/sending any audio at all, then calls streamChunk repeatedly
// (one small ordinary POST per chunk of raw PCM audio) and finally
// streamFinish. See liveAasSession.js for why this is three small,
// ordinary HTTP requests instead of one continuous streaming upload.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const config = require('../lib/config');
const ambientSession = require('../lib/ambientSession');
const liveAasSession = require('../lib/liveAasSession');
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

  const authHeader = request.headers.get('authorization') || '';
  const entraUserToken = authHeader.replace(/^Bearer\s+/i, '') || undefined;
  if (!entraUserToken) {
    return withCors({
      status: 401,
      body: 'Missing Authorization header (expected the physician\'s Entra sign-in token).',
    });
  }

  const correlationId = request.query.get('correlationId') || crypto.randomUUID();
  const externalUserId = request.query.get('externalUserId') || undefined;
  const ehrInstanceId = request.query.get('ehrInstanceId') || undefined;
  const recordingId = parseInt(request.query.get('recordingId'), 10) || 1;
  const outputFormIdsRaw = request.query.get('outputFormIds');
  const outputFormIds = outputFormIdsRaw
    ? outputFormIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const contextRaw = request.query.get('context');
  let sessionData;
  if (contextRaw) {
    try {
      sessionData = JSON.parse(contextRaw);
    } catch {
      return withCors({ status: 400, body: '"context" query param must be valid JSON.' });
    }
  }

  try {
    await ambientSession.createAmbientSession({ correlationId, externalUserId, data: sessionData, ehrInstanceId });
    await liveAasSession.startSession({
      correlationId,
      recordingId,
      ehrInstanceId,
      externalUserId,
      outputFormIds,
      entraUserToken,
      log: context.log.bind(context),
    });
  } catch (err) {
    context.error(`streamStart failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  return withCors({ status: 200, jsonBody: { correlationId } });
}

app.http('streamStart', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'streamStart',
  handler,
});

module.exports = { handler };
