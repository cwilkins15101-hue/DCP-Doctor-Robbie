// Ends a live-streaming recording (web only, 2026-09-24) — sends
// RecordingClose on the session started by streamStart, waits for
// RecordingCloseResponse, then ends the ambient session. The app calls
// this once, after it's done sending streamChunk requests.
const { app } = require('@azure/functions');
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

  const correlationId = request.query.get('correlationId');
  if (!correlationId) {
    return withCors({ status: 400, body: 'Missing correlationId query param.' });
  }
  const recordingLengthSeconds = parseInt(request.query.get('recordingLengthSeconds'), 10) || 1;

  try {
    await liveAasSession.finishSession({ correlationId, recordingLengthSeconds });
  } catch (err) {
    context.error(`streamFinish failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  try {
    await ambientSession.endAmbientSession(correlationId);
  } catch (err) {
    context.warn(`endAmbientSession failed for ${correlationId} (non-fatal):`, err);
  }

  return withCors({ status: 200, jsonBody: { correlationId } });
}

app.http('streamFinish', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'streamFinish',
  handler,
});

module.exports = { handler };
