const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

const storage = require('../src/lib/storage');
const savedEncounters = [];
storage.saveEncounter = async (externalUserId, correlationId, patient) => {
  savedEncounters.push({ externalUserId, correlationId, patient });
};

const { handler } = require('../src/functions/recordEncounter');

const noopContext = { log: () => {}, warn: () => {}, error: () => {} };

function fakeJsonRequest({ method = 'POST', headers = {}, body } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

test.beforeEach(() => {
  savedEncounters.length = 0;
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await handler(fakeJsonRequest({ method: 'OPTIONS' }), noopContext);
  assert.equal(res.status, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('rejects requests without the app secret', async () => {
  const res = await handler(fakeJsonRequest({ body: {} }), noopContext);
  assert.equal(res.status, 401);
});

test('rejects requests missing correlationId', async () => {
  const res = await handler(
    fakeJsonRequest({ headers: { 'x-app-secret': 'test-app-secret' }, body: { externalUserId: 'dr-1' } }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('rejects requests missing externalUserId', async () => {
  const res = await handler(
    fakeJsonRequest({ headers: { 'x-app-secret': 'test-app-secret' }, body: { correlationId: 'corr-1' } }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('saves the encounter and returns the correlationId', async () => {
  const res = await handler(
    fakeJsonRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      body: { correlationId: 'corr-1', externalUserId: 'dr-1', patient: { 'Patient Name': 'Jane Smith' } },
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.correlationId, 'corr-1');
  assert.equal(savedEncounters.length, 1);
  assert.deepEqual(savedEncounters[0], {
    externalUserId: 'dr-1',
    correlationId: 'corr-1',
    patient: { 'Patient Name': 'Jane Smith' },
  });
});

test('returns 502 if saveEncounter fails', async () => {
  storage.saveEncounter = async () => {
    throw new Error('boom');
  };
  const res = await handler(
    fakeJsonRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      body: { correlationId: 'corr-2', externalUserId: 'dr-1' },
    }),
    noopContext
  );
  assert.equal(res.status, 502);
});
