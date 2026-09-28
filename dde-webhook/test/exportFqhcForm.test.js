const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WEBHOOK_SHARED_SECRET = 'test-webhook-secret';
process.env.APP_SHARED_SECRET = 'test-app-secret';
process.env.ENTRA_TENANT_ID = 'tenant';
process.env.ENTRA_CLIENT_ID = 'client';
process.env.ENTRA_CLIENT_SECRET = 'secret';
process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

const { handler } = require('../src/functions/exportFqhcForm');

const noopContext = { log: () => {}, warn: () => {}, error: () => {} };

function fakeRequest({ method = 'POST', headers = {}, jsonBody } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => {
      if (jsonBody === undefined) throw new Error('no body');
      return jsonBody;
    },
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

test('rejects a request with no JSON body', async () => {
  const res = await handler(fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' } }), noopContext);
  assert.equal(res.status, 400);
});

test('rejects a request missing the fields object', async () => {
  const res = await handler(
    fakeRequest({ headers: { 'x-app-secret': 'test-app-secret' }, jsonBody: {} }),
    noopContext
  );
  assert.equal(res.status, 400);
});

test('returns a populated .xlsx attachment', async () => {
  const res = await handler(
    fakeRequest({
      headers: { 'x-app-secret': 'test-app-secret' },
      jsonBody: { fields: { 'Full Legal Name': 'Jane Doe' } },
    }),
    noopContext
  );
  assert.equal(res.status, 200);
  assert.equal(
    res.headers['Content-Type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.match(res.headers['Content-Disposition'], /attachment; filename="fqhc-sliding-fee-scale\.xlsx"/);
  assert.ok(res.body && res.body.length > 0);
});
