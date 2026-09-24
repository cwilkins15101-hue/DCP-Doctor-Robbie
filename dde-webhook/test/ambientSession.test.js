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

const calls = [];
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  calls.push({ url: url.toString(), options });
  return { ok: true, status: 200, json: async () => ({ message: 'OK' }), text: async () => 'OK' };
};

const { createAmbientSession, endAmbientSession } = require('../src/lib/ambientSession');

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

test('createAmbientSession merges outputFormIds into data.formIds (Voice-to-Form, REST modality)', async () => {
  await createAmbientSession({
    correlationId: 'corr-1',
    data: { patientName: 'Jane Smith' },
    outputFormIds: ['visit_summary', 'letter_to_patient'],
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(JSON.parse(body.data), {
    patientName: 'Jane Smith',
    formIds: ['visit_summary', 'letter_to_patient'],
  });
});

test('createAmbientSession sends formIds even with no other session data', async () => {
  await createAmbientSession({ correlationId: 'corr-1', outputFormIds: ['visit_summary'] });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(JSON.parse(body.data), { formIds: ['visit_summary'] });
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

test.after(() => {
  global.fetch = originalFetch;
});
