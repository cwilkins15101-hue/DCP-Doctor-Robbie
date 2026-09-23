// Called by the Doctor Robbie app once a recording is finished. Orchestrates
// the whole Dragon Copilot flow: create an ambient session (with
// patient/encounter context), stream the audio over the Ambient Audio
// Streaming WebSocket API (real-time transport, replacing the older REST
// chunked-upload flow — switched for faster downstream processing), then
// end the session. Results arrive later via the existing webhook +
// getResult poll.
//
// The AAS WebSocket call needs a real Entra *user* (delegated) access
// token, not an app-only one — confirmed live by Dragon Copilot's support
// team (2026-09-23) after a live submission hung indefinitely with no
// server response despite a fully protocol-correct request. The app
// forwards the physician's own already-obtained sign-in token (see
// msftAuth.js/dragonCopilotBackend.js) as this request's own Authorization
// header; this function just passes it through to audioStreamUpload rather
// than dde-webhook minting its own app-only token for that specific call.
// The REST ambient-sessions calls below (ambientSession.js) are unaffected
// — a different API/scope, already confirmed working with an app-only
// token.
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

  // The physician's own delegated Entra token, forwarded by the app — the
  // AAS WebSocket call needs this specifically (see header comment above).
  const authHeader = request.headers.get('authorization') || '';
  const entraUserToken = authHeader.replace(/^Bearer\s+/i, '') || undefined;
  if (!entraUserToken) {
    return withCors({
      status: 401,
      body: 'Missing Authorization header (expected the physician\'s Entra sign-in token).',
    });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return withCors({ status: 400, body: 'Expected multipart/form-data with an "audio" field.' });
  }

  const audioFile = form.get('audio');
  if (!audioFile || typeof audioFile.arrayBuffer !== 'function') {
    return withCors({ status: 400, body: 'Missing "audio" field (the recorded audio file).' });
  }

  const correlationId = form.get('correlationId') || crypto.randomUUID();
  const externalUserId = form.get('externalUserId') || undefined;
  const ehrInstanceId = form.get('ehrInstanceId') || undefined;
  // Distinguishes multiple recordings added to the same encounter
  // (correlationId) — reusing recordingId 1 for a second recording looks
  // to Dragon Copilot like re-finalizing the same take, which is why a
  // second recording on an existing encounter never triggered a new
  // notification. Defaults to 1 for a first/only recording.
  const recordingId = parseInt(form.get('recordingId'), 10) || 1;
  // RecordingClose (AAS WebSocket) documents this as required — used to be
  // hardcoded to 0 server-side, which is never accurate for a real
  // recording; the app now measures and sends the real value.
  const recordingLengthSeconds = parseInt(form.get('recordingLengthSeconds'), 10) || 1;
  // Voice-to-Form — requests one or more template forms instead of (or
  // alongside) the standard clinical note. Sent by the app as a
  // comma-separated list (e.g. "encounter_note_pi_mdm").
  const outputFormIdsRaw = form.get('outputFormIds');
  const outputFormIds = outputFormIdsRaw
    ? outputFormIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const contextRaw = form.get('context');
  let sessionData;
  if (contextRaw) {
    try {
      sessionData = JSON.parse(contextRaw);
    } catch {
      return withCors({ status: 400, body: '"context" field must be valid JSON.' });
    }
  }

  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  if (audioBuffer.length === 0) {
    return withCors({ status: 400, body: 'Audio file is empty.' });
  }

  try {
    await ambientSession.createAmbientSession({ correlationId, externalUserId, data: sessionData, ehrInstanceId });
    await audioStreamUpload.streamRecording({
      correlationId,
      audioBuffer,
      recordingId,
      recordingLengthSeconds,
      ehrInstanceId,
      externalUserId,
      outputFormIds,
      entraUserToken,
      // Must stay bound to `context` — @azure/functions v4's context.log
      // uses real private class fields internally, so passing the bare
      // method reference (as this used to) detaches it from that internal
      // state and throws "Cannot read private member from an object whose
      // class did not declare it" the moment it's called from inside an
      // async WebSocket event callback, crashing the whole worker process
      // (confirmed live, 2026-09-23 — a real regression from adding this
      // logging in the first place).
      log: context.log.bind(context),
    });
  } catch (err) {
    context.error(`submitRecording failed for correlationId ${correlationId}:`, err);
    return withCors({ status: 502, jsonBody: { error: String(err?.message ?? err) } });
  }

  // Non-fatal: the recording is already submitted for processing at this
  // point regardless of whether the cleanup call below succeeds.
  try {
    await ambientSession.endAmbientSession(correlationId);
  } catch (err) {
    context.warn(`endAmbientSession failed for ${correlationId} (non-fatal):`, err);
  }

  return withCors({ status: 200, jsonBody: { correlationId } });
}

app.http('submitRecording', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'submitRecording',
  handler,
});

module.exports = { handler };
