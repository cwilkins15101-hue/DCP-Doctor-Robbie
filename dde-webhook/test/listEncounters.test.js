const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

const storage = require('../src/lib/storage');
storage.listEncounters = async (externalUserId) => {
  if (externalUserId === 'dr-1') {
    return [
      { correlationId: 'corr-2', patient: { 'Patient Name': 'John Doe' }, startedAt: '2026-09-25T10:00:00Z' },
      { correlationId: 'corr-1', patient: null, startedAt: '2026-09-24T10:00:00Z' },
    ];
  }
  return [];
};

const { handler } = require('../src/functions/listEncounters');

const noopContext = { log: () => {}, warn: () => {}, error: () => {} };

function fakeRequest({ method = 'GET', headers = {}, query = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const queryMap = new Map(Object.entries(query));
  return {
    method,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    query: { get: (name) => queryMap.get(name) ?? null },
  };
}

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await handler(fakeRequest({ method: 'OPTIONS' }), noopContext);
  assert.equal(res.status, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('rejects requests without the app secret', async () => {
  const res = await handler(fakeRequest({}), noopContext);
  assert.equal(res.status, 401);
});

test('rejects requests without externalUserId', async () => {
  const res = await handler(fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' } }), noopContext);
  assert.equal(res.status, 400);
});

test('returns this physician\'s encounters', async () => {
  const res = await handler(
    fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' }, query: { externalUserId: 'dr-1' } }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.encounters.length, 2);
  assert.equal(res.jsonBody.encounters[0].correlationId, 'corr-2');
});

test('returns an empty list for a physician with no encounters', async () => {
  const res = await handler(
    fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' }, query: { externalUserId: 'dr-nobody' } }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody.encounters, []);
});

test('returns 502 if listEncounters fails', async () => {
  storage.listEncounters = async () => {
    throw new Error('boom');
  };
  const res = await handler(
    fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' }, query: { externalUserId: 'dr-1' } }),
    noopContext
  );
  assert.equal(res.status, 502);
});
