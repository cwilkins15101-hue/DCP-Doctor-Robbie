// Called by the Doctor Robbie app once a recording is finished. Orchestrates
// the whole no-popup Dragon Copilot flow: create an ambient session (with
// patient/encounter context), stream the audio over the Ambient Audio
// Streaming WebSocket API (real-time transport, replacing the older REST
// chunked-upload flow — switched for faster downstream processing and
// because Voice-to-Form's outputFormIds field only exists on this API),
// then end the session. The physician never signs in to Microsoft — this
// is a pure app-only, server-to-server flow, per the documented
// externalUserId-based identity model. Results arrive later via the
// existing webhook + getResult poll.
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
      log: context.log,
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
