const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
process.env.DRAGON_PARTNER_GUID = 'partner-guid';
process.env.DRAGON_ENVIRONMENT_ID = 'customer-guid';

const ambientSession = require('../src/lib/ambientSession');
const audioStreamUpload = require('../src/lib/audioStreamUpload');

const recordedCalls = [];
ambientSession.createAmbientSession = async (args) => {
  recordedCalls.push({ fn: 'createAmbientSession', args });
  return { message: 'OK' };
};
ambientSession.endAmbientSession = async (correlationId) => {
  recordedCalls.push({ fn: 'endAmbientSession', correlationId });
  return { message: 'OK' };
};
audioStreamUpload.streamRecording = async (args) => {
  recordedCalls.push({ fn: 'streamRecording', args });
  return { dataStored: args.audioBuffer.length };
};

const { handler } = require('../src/functions/submitRecording');

const noopContext = { log: () => {}, warn: () => {}, error: () => {} };

function fakeFormDataRequest({ method = 'POST', headers = {}, fields = {}, audioBytes } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  if (audioBytes) {
    form.append('audio', new Blob([audioBytes]), 'recording.wav');
  }
  return {
    method,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    formData: async () => form,
  };
}

test.beforeEach(() => {
  recordedCalls.length = 0;
});

test('OPTIONS preflight returns 204 with CORS headers, without touching auth or the form body', async () => {
  const res = await handler(fakeFormDataRequest({ method: 'OPTIONS' }), noopContext);
  assert.equal(res.status, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Access-Control-Allow-Methods'], /OPTIONS/);
  assert.match(res.headers['Access-Control-Allow-Headers'], /x-app-secret/i);
});

test('rejects requests without the app secret', async () => {
  const res = await handler(fakeFormDataRequest({}), noopContext);
  assert.equal(res.status, 401);
});

test('real responses also carry CORS headers', async () => {
  const res = await handler(fakeFormDataRequest({}), noopContext);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('rejects requests with no audio field', async () => {
  const res = await handler(
    fakeFormDataRequest({ headers: { 'x-app-secret': 'test-app-secret' } }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('rejects invalid JSON in the context field', async () => {
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      fields: { context: 'not json' },
      audioBytes: Buffer.from([1, 2, 3]),
    }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('orchestrates create session -> stream upload -> end session, and returns the correlationId', async () => {
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      fields: {
        correlationId: 'corr-42',
        externalUserId: 'dr-robbie-1',
        context: JSON.stringify({ patientName: 'Jane Smith' }),
      },
      audioBytes: Buffer.from([1, 2, 3, 4]),
    }),
    noopContext
  );

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.correlationId, 'corr-42');

  assert.equal(recordedCalls.length, 3);
  assert.equal(recordedCalls[0].fn, 'createAmbientSession');
  assert.equal(recordedCalls[0].args.correlationId, 'corr-42');
  assert.equal(recordedCalls[0].args.externalUserId, 'dr-robbie-1');
  assert.deepEqual(recordedCalls[0].args.data, { patientName: 'Jane Smith' });

  assert.equal(recordedCalls[1].fn, 'streamRecording');
  assert.equal(recordedCalls[1].args.correlationId, 'corr-42');
  assert.equal(recordedCalls[1].args.recordingId, 1);
  assert.ok(Buffer.isBuffer(recordedCalls[1].args.audioBuffer));
  assert.equal(recordedCalls[1].args.audioBuffer.length, 4);
  assert.equal(recordedCalls[1].args.outputFormIds, undefined);

  assert.equal(recordedCalls[2].fn, 'endAmbientSession');
  assert.equal(recordedCalls[2].correlationId, 'corr-42');
});

test('passes through a distinct recordingId for an additional recording on the same encounter', async () => {
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      fields: { correlationId: 'corr-42', recordingId: '2' },
      audioBytes: Buffer.from([1, 2]),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  const uploadCall = recordedCalls.find((c) => c.fn === 'streamRecording');
  assert.equal(uploadCall.args.correlationId, 'corr-42');
  assert.equal(uploadCall.args.recordingId, 2);
});

test('parses a comma-separated outputFormIds field for Voice-to-Form', async () => {
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      fields: { correlationId: 'corr-43', outputFormIds: 'encounter_note_pi_mdm, letter_to_patient' },
      audioBytes: Buffer.from([1, 2]),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  const uploadCall = recordedCalls.find((c) => c.fn === 'streamRecording');
  assert.deepEqual(uploadCall.args.outputFormIds, ['encounter_note_pi_mdm', 'letter_to_patient']);
});

test('generates a correlationId when none is provided', async () => {
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      audioBytes: Buffer.from([1]),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.ok(res.jsonBody.correlationId);
});

test('still succeeds if endAmbientSession fails (non-fatal)', async () => {
  ambientSession.endAmbientSession = async () => {
    throw new Error('boom');
  };
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      fields: { correlationId: 'corr-99' },
      audioBytes: Buffer.from([1]),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.correlationId, 'corr-99');
});

test('returns 502 if streamRecording fails', async () => {
  audioStreamUpload.streamRecording = async () => {
    throw new Error('upload failed');
  };
  const res = await handler(
    fakeFormDataRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      audioBytes: Buffer.from([1]),
    }),
    noopContext
  );
  assert.equal(res.status, 502);
});
