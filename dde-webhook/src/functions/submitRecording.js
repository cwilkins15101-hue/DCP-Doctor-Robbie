// Called by the Doctor Robbie app once a recording is finished. Orchestrates
// the whole no-popup Dragon Copilot flow: create an ambient session (with
// patient/encounter context), upload the audio via Ambient Audio Streaming,
// finalize (triggers Dragon Copilot processing), then end the session.
// The physician never signs in to Microsoft — this is a pure app-only,
// server-to-server flow, per the documented externalUserId-based identity
// model. Results arrive later via the existing webhook + getResult poll.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const config = require('../lib/config');
const ambientSession = require('../lib/ambientSession');
const audioUpload = require('../lib/audioUpload');

async function handler(request, context) {
  const providedSecret = request.headers.get('x-app-secret');
  if (providedSecret !== config.appSharedSecret()) {
    return { status: 401, body: 'Unauthorized' };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return { status: 400, body: 'Expected multipart/form-data with an "audio" field.' };
  }

  const audioFile = form.get('audio');
  if (!audioFile || typeof audioFile.arrayBuffer !== 'function') {
    return { status: 400, body: 'Missing "audio" field (the recorded audio file).' };
  }

  const correlationId = form.get('correlationId') || crypto.randomUUID();
  const externalUserId = form.get('externalUserId') || undefined;
  const ehrInstanceId = form.get('ehrInstanceId') || undefined;

  const contextRaw = form.get('context');
  let sessionData;
  if (contextRaw) {
    try {
      sessionData = JSON.parse(contextRaw);
    } catch {
      return { status: 400, body: '"context" field must be valid JSON.' };
    }
  }

  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  if (audioBuffer.length === 0) {
    return { status: 400, body: 'Audio file is empty.' };
  }

  try {
    await ambientSession.createAmbientSession({ correlationId, externalUserId, data: sessionData, ehrInstanceId });
    await audioUpload.uploadRecording({ correlationId, audioBuffer, ehrInstanceId, externalUserId });
  } catch (err) {
    context.error(`submitRecording failed for correlationId ${correlationId}:`, err);
    return { status: 502, jsonBody: { error: String(err?.message ?? err) } };
  }

  // Non-fatal: the recording is already submitted for processing at this
  // point regardless of whether the cleanup call below succeeds.
  try {
    await ambientSession.endAmbientSession(correlationId);
  } catch (err) {
    context.warn(`endAmbientSession failed for ${correlationId} (non-fatal):`, err);
  }

  return { status: 200, jsonBody: { correlationId } };
}

app.http('submitRecording', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'submitRecording',
  handler,
});

module.exports = { handler };
