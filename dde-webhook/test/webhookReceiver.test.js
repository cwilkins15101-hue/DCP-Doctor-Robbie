const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

// Stub the two modules that talk to the outside world BEFORE requiring the
// function under test, so its destructured references pick up the stubs.
const storage = require('../src/lib/storage');
const savedResults = [];
storage.saveResult = async (correlationId, artifactType, payload) => {
  savedResults.push({ correlationId, artifactType, payload });
};
storage.getResults = async (correlationId) => {
  if (correlationId === 'known-id') {
    return { drc_native_note: { data: { some: 'stored data' }, storedAt: '2026-01-01T00:00:00Z' } };
  }
  return null;
};

const dragonApiAuth = require('../src/lib/dragonApiAuth');
dragonApiAuth.getDragonApiToken = async () => 'fake-token';

const originalFetch = global.fetch;
global.fetch = async (url) => {
  assert.equal(url, 'https://example.com/retrieval/123');
  return {
    ok: true,
    json: async () => ({ transcript: 'hello world' }),
  };
};

const { handler: webhookHandler } = require('../src/functions/webhookReceiver');
const { handler: getResultHandler } = require('../src/functions/getResult');

function fakeRequest({ method = 'POST', headers = {}, query = {}, body = '' } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const queryMap = new Map(Object.entries(query));
  return {
    method,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    query: { get: (name) => queryMap.get(name) ?? null },
    text: async () => body,
  };
}

const noopContext = { log: () => {}, warn: () => {}, error: () => {} };

test('OPTIONS without WebHook-Request-Origin returns 400', async () => {
  const res = await webhookHandler(fakeRequest({ method: 'OPTIONS' }), noopContext);
  assert.equal(res.status, 400);
});

test('OPTIONS with WebHook-Request-Origin echoes it back correctly', async () => {
  const res = await webhookHandler(
    fakeRequest({ method: 'OPTIONS', headers: { 'WebHook-Request-Origin': 'eventgrid.azure.net' } }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers['WebHook-Allowed-Origin'], 'eventgrid.azure.net');
  assert.equal(res.headers['WebHook-Allowed-Rate'], '*');
});

test('POST with wrong access_token is rejected', async () => {
  const res = await webhookHandler(
    fakeRequest({ query: { access_token: 'wrong' }, body: '{}' }),
    noopContext
  );
  assert.equal(res.status, 401);
});

test('POST with invalid JSON body returns 400', async () => {
  const res = await webhookHandler(
    fakeRequest({ query: { access_token: 'test-webhook-secret' }, body: 'not json' }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('POST with valid JSON missing specversion returns 400', async () => {
  const res = await webhookHandler(
    fakeRequest({ query: { access_token: 'test-webhook-secret' }, body: JSON.stringify({ type: 'x' }) }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('POST with unrecognized event type is acknowledged but not stored', async () => {
  savedResults.length = 0;
  const res = await webhookHandler(
    fakeRequest({
      query: { access_token: 'test-webhook-secret' },
      body: JSON.stringify({ specversion: '1.0', type: 'some_other_event', data: {} }),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(savedResults.length, 0);
});

test('POST with recognized event type retrieves and stores the data', async () => {
  savedResults.length = 0;
  const res = await webhookHandler(
    fakeRequest({
      query: { access_token: 'test-webhook-secret' },
      body: JSON.stringify({
        specversion: '1.0',
        type: 'encounter_data_ready_complete',
        data: {
          retrievalUrl: 'https://example.com/retrieval/123',
          correlationId: 'corr-1',
          customerId: 'cust-1',
          userId: 'user-1',
        },
      }),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(savedResults.length, 1);
  assert.equal(savedResults[0].correlationId, 'corr-1');
  assert.equal(savedResults[0].artifactType, 'unknown');
  assert.deepEqual(savedResults[0].payload.data, { transcript: 'hello world' });
  assert.equal(savedResults[0].payload.customerId, 'cust-1');
});

test('POST with a note artifact stores it under its artifact_type', async () => {
  savedResults.length = 0;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: JSON.stringify({ artifact_type: 'drc_native_note', resources: [] }) }),
  });
  const res = await webhookHandler(
    fakeRequest({
      query: { access_token: 'test-webhook-secret' },
      body: JSON.stringify({
        specversion: '1.0',
        type: 'encounter_data_ready_complete',
        data: { retrievalUrl: 'https://example.com/retrieval/123', correlationId: 'corr-2' },
      }),
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(savedResults.length, 1);
  assert.equal(savedResults[0].artifactType, 'drc_native_note');
});

test('getResult OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await getResultHandler(fakeRequest({ method: 'OPTIONS', headers: {}, query: {} }), noopContext);
  assert.equal(res.status, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('getResult rejects requests without the app secret', async () => {
  const res = await getResultHandler(fakeRequest({ method: 'GET', headers: {}, query: {} }), noopContext);
  assert.equal(res.status, 401);
});

test('getResult real responses also carry CORS headers', async () => {
  const res = await getResultHandler(fakeRequest({ method: 'GET', headers: {}, query: {} }), noopContext);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('getResult returns 400 without a correlationId', async () => {
  const res = await getResultHandler(
    fakeRequest({ method: 'GET', headers: { 'x-app-secret': 'test-app-secret' }, query: {} }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('getResult returns 202 pending for an unknown correlationId', async () => {
  const res = await getResultHandler(
    fakeRequest({
      method: 'GET',
      headers: { 'x-app-secret': 'test-app-secret' },
      query: { correlationId: 'unknown-id' },
    }),
    noopContext
  );
  assert.equal(res.status, 202);
  assert.equal(res.jsonBody.status, 'pending');
});

test('getResult returns 200 with data for a known correlationId', async () => {
  const res = await getResultHandler(
    fakeRequest({
      method: 'GET',
      headers: { 'x-app-secret': 'test-app-secret' },
      query: { correlationId: 'known-id' },
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.status, 'ready');
  assert.deepEqual(res.jsonBody.artifacts, {
    drc_native_note: { data: { some: 'stored data' }, storedAt: '2026-01-01T00:00:00Z' },
  });
});

test.after(() => {
  global.fetch = originalFetch;
});
