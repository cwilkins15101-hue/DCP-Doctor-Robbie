// Called by the Doctor Robbie app (web only, 2026-09-24) while a recording
// is IN PROGRESS -- the request body is a live stream of raw PCM audio
// bytes, sent as the physician speaks, not a finished file uploaded
// afterward. That's the core difference from submitRecording.js/
// audioStreamUpload.streamRecording(): this app records the whole clip
// first, then dumps it through the WebSocket in one instantaneous burst,
// which never gets any response from Dragon Copilot despite being fully
// protocol-correct -- the leading theory being that a real-time streaming
// pipeline has nothing sensible to do with audio arriving far faster than
// real time. This function instead opens the AAS WebSocket immediately and
// forwards each chunk of the incoming request body the moment it arrives,
// via audioStreamUpload.streamRecordingLive().
//
// Metadata travels as query params, not multipart form fields -- the whole
// request body is audio, so there's no room left for form-encoded fields
// the way submitRecording.js has them.
//
// Needs enableHttpStream (see _setup.js) for request.body to be a live
// ReadableStream fed incrementally, rather than the whole body pre-buffered
// before this handler even runs -- without that, this is no different from
// submitRecording.js's store-and-forward, just with extra steps.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const config = require('../lib/config');
const ambientSession = require('../lib/ambientSession');
const audioStreamUpload = require('../lib/audioStreamUpload');
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

  // The physician's own delegated Entra token — see submitRecording.js's
  // header comment for why this specific token type is required.
  const authHeader = request.headers.get('authorization') || '';
  const entraUserToken = authHeader.replace(/^Bearer\s+/i, '') || undefined;
  if (!entraUserToken) {
    return withCors({
      status: 401,
      body: 'Missing Authorization header (expected the physician\'s Entra sign-in token).',
    });
  }

  if (!request.body) {
    return withCors({ status: 400, body: 'Missing request body (expected a live stream of raw PCM audio bytes).' });
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
    await audioStreamUpload.streamRecordingLive({
      correlationId,
      incomingChunks: request.body,
      recordingId,
      ehrInstanceId,
      externalUserId,
      outputFormIds,
      entraUserToken,
      // Must stay bound to `context` -- see submitRecording.js's comment on
      // the exact crash this avoids.
      log: context.log.bind(context),
    });
  } catch (err) {
    context.error(`streamRecordingLive failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  try {
    await ambientSession.endAmbientSession(correlationId);
  } catch (err) {
    context.warn(`endAmbientSession failed for ${correlationId} (non-fatal):`, err);
  }

  return withCors({ status: 200, jsonBody: { correlationId } });
}

app.http('streamRecordingLive', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'streamRecordingLive',
  handler,
});

module.exports = { handler };
