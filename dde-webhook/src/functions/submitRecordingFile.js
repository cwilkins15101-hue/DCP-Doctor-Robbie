// Handles the "Upload a file" flow only (manual file picker + submit
// button) — a separate, distinctly-named endpoint from submitRecording.js
// (used by mic recordings, over the AAS WebSocket) so that path is
// untouched. Restored 2026-09-24: uploads via the Ambient Audio Streaming
// REST API (storeChunk/finalizeUpload, audioUpload.js) instead of the AAS
// WebSocket. A pure app-only, server-to-server flow — the physician never
// signs in to Microsoft for this. Supports Voice-to-Form (outputFormIds)
// too, confirmed 2026-09-24 from Microsoft's V2F onboarding guide — for
// this REST modality it's passed as "formIds" inside the ambient session's
// data field (see ambientSession.js), not on the upload call itself.
// Results arrive later via the existing webhook + getResult poll, same as
// every other submission path.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const config = require('../lib/config');
const ambientSession = require('../lib/ambientSession');
const audioUpload = require('../lib/audioUpload');
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
    await ambientSession.createAmbientSession({ correlationId, externalUserId, data: sessionData, ehrInstanceId, outputFormIds });
    await audioUpload.uploadRecording({ correlationId, audioBuffer, recordingId, ehrInstanceId, externalUserId });
  } catch (err) {
    context.error(`submitRecordingFile failed for correlationId ${correlationId}:`, err);
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

app.http('submitRecordingFile', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'submitRecordingFile',
  handler,
});

module.exports = { handler };
