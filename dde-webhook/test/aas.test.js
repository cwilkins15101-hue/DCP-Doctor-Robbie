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

const dragonApiAuth = require('../src/lib/dragonApiAuth');
dragonApiAuth.getDragonApiToken = async () => 'fake-dragon-token';
dragonApiAuth.getAasToken = async () => 'fake-aas-token';

const calls = [];
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  calls.push({ url: url.toString(), options });
  return { ok: true, status: 200, json: async () => ({ message: 'OK' }), text: async () => 'OK' };
};

const { createAmbientSession, endAmbientSession } = require('../src/lib/ambientSession');
const { uploadRecording, CHUNK_SIZE_BYTES } = require('../src/lib/audioUpload');

test.beforeEach(() => {
  calls.length = 0;
});

test('createAmbientSession PUTs to the Partner API host with the right body', async () => {
  await createAmbientSession({ correlationId: 'corr-1', externalUserId: 'user-1', data: { foo: 'bar' } });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(options.method, 'PUT');
  assert.ok(url.startsWith('https://partnerapi.copilot.us.dragon.com/ambient-sessions?'));
  assert.ok(url.includes('customerId=customer-guid'));
  assert.equal(options.headers.Authorization, 'Bearer fake-dragon-token');
  const body = JSON.parse(options.body);
  assert.equal(body.correlationId, 'corr-1');
  assert.equal(body.partnerId, 'partner-guid');
  assert.equal(body.customerId, 'customer-guid');
  assert.equal(body.externalUserId, 'user-1');
  assert.equal(body.data, JSON.stringify({ foo: 'bar' }));
});

test('endAmbientSession DELETEs the session by correlationId', async () => {
  await endAmbientSession('corr-1');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(options.method, 'DELETE');
  assert.ok(url.startsWith('https://partnerapi.copilot.us.dragon.com/ambient-sessions/corr-1?'));
});

test('createAmbientSession throws with response body on failure', async () => {
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  await assert.rejects(
    () => createAmbientSession({ correlationId: 'corr-1' }),
    /createAmbientSession failed \(400\): bad request/
  );
  global.fetch = async (url, options = {}) => {
    calls.push({ url: url.toString(), options });
    return { ok: true, status: 200, json: async () => ({ message: 'OK' }), text: async () => 'OK' };
  };
});

test('uploadRecording sends an empty chunk 1, then data chunks with correct sequencing, then finalizes', async () => {
  const audioBuffer = Buffer.alloc(CHUNK_SIZE_BYTES + 100, 7); // spans two chunks
  await uploadRecording({ correlationId: 'corr-2', audioBuffer, externalUserId: 'user-2' });

  // 1 empty placeholder chunk + 2 data chunks + 1 finalize call = 4 requests
  assert.equal(calls.length, 4);

  const [chunk1, chunk2, chunk3, finalize] = calls;

  // Chunk 1: metadata only, no "content" part, chunkId 1
  assert.equal(chunk1.url.includes('/audio/storeChunk'), true);
  assert.equal(chunk1.options.method, 'PUT');
  const chunk1Metadata = JSON.parse(chunk1.options.body.get('metadata'));
  assert.equal(chunk1Metadata.chunkId, 1);
  assert.equal(chunk1Metadata.correlationId, 'corr-2');
  assert.equal(chunk1.options.body.has('content'), false);
  assert.ok(chunk1.options.headers['x-correlation-id']);

  // Chunk 2: first data chunk, chunkId 2, not last
  const chunk2Metadata = JSON.parse(chunk2.options.body.get('metadata'));
  assert.equal(chunk2Metadata.chunkId, 2);
  assert.equal(chunk2Metadata.isLast, false);
  assert.equal(chunk2.options.body.has('content'), true);

  // Chunk 3: second (final) data chunk, chunkId 3, isLast true
  const chunk3Metadata = JSON.parse(chunk3.options.body.get('metadata'));
  assert.equal(chunk3Metadata.chunkId, 3);
  assert.equal(chunk3Metadata.isLast, true);

  // Every AAS call gets its own fresh x-correlation-id trace header —
  // distinct from the session-level correlationId in the body.
  const traceIds = new Set([
    chunk1.options.headers['x-correlation-id'],
    chunk2.options.headers['x-correlation-id'],
    chunk3.options.headers['x-correlation-id'],
    finalize.options.headers['x-correlation-id'],
  ]);
  assert.equal(traceIds.size, 4);

  // Finalize: totalChunks includes the empty chunk 1 (3 storeChunk calls total)
  assert.ok(finalize.url.includes('/audio/finalizeUpload'));
  assert.equal(finalize.options.method, 'POST');
  const finalizeBody = JSON.parse(finalize.options.body);
  assert.equal(finalizeBody.totalChunks, 3);
  assert.equal(finalizeBody.correlationId, 'corr-2');
  assert.equal(finalizeBody.recordingId, 1);
});

test.after(() => {
  global.fetch = originalFetch;
});
