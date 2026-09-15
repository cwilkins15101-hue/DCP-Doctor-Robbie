const { app } = require('@azure/functions');
const config = require('../lib/config');
const { getDragonApiToken } = require('../lib/dragonApiAuth');
const { saveResult } = require('../lib/storage');

// Handles the Azure Event Grid / Dragon Data Exchange validation handshake.
// Required exactly as documented: echo WebHook-Request-Origin back as
// WebHook-Allowed-Origin, and declare an allowed delivery rate.
function handleOptionsValidation(request) {
  const origin = request.headers.get('webhook-request-origin');
  if (!origin) {
    return {
      status: 400,
      body: 'Webhook validation failed: missing WebHook-Request-Origin header.',
    };
  }
  return {
    status: 200,
    headers: {
      'WebHook-Allowed-Origin': origin,
      'WebHook-Allowed-Rate': '*',
    },
  };
}

async function fetchRetrievalData(retrievalUrl) {
  const token = await getDragonApiToken();
  const response = await fetch(retrievalUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Retrieval service returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// The retrieval response's `data` field is itself a JSON string carrying
// artifact_type (e.g. "drc_native_note" for the note, a different value for
// a transcript) — Dragon Copilot delivers these as separate notifications
// for the same correlationId, so this is what tells them apart in storage.
function extractArtifactType(retrievalData) {
  try {
    const inner = typeof retrievalData?.data === 'string' ? JSON.parse(retrievalData.data) : null;
    return inner?.artifact_type || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function handleNotification(request, context) {
  // Simplest of the three documented security options: a shared secret
  // passed as ?access_token=... when the subscription was provisioned.
  const providedSecret = request.query.get('access_token');
  if (providedSecret !== config.webhookSharedSecret()) {
    context.warn('Webhook call rejected: access_token missing or incorrect.');
    return { status: 401, body: 'Unauthorized' };
  }

  const rawBody = await request.text();
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: 'Invalid JSON body.' };
  }

  if (!event.specversion) {
    return { status: 400, body: 'Body does not conform to the CloudEvents schema.' };
  }

  const eventType = event.type;
  if (!config.recognizedEventTypes().includes(eventType)) {
    context.log(`Ignoring notification of type "${eventType}" — not in the recognized list.`);
    return { status: 200 };
  }

  const { retrievalUrl, correlationId } = event.data ?? {};
  if (!retrievalUrl || !correlationId) {
    context.warn('Notification had no retrievalUrl/correlationId — nothing to fetch.');
    return { status: 200 };
  }

  try {
    const data = await fetchRetrievalData(retrievalUrl);
    const artifactType = extractArtifactType(data);
    await saveResult(correlationId, artifactType, {
      eventType,
      customerId: event.data.customerId,
      userId: event.data.userId,
      receivedAt: new Date().toISOString(),
      data,
    });
    context.log(`Stored "${artifactType}" artifact for correlationId ${correlationId}.`);
  } catch (err) {
    // Log and still return 200 — Event Grid will retry deliveries on
    // failure responses, which isn't what we want for an error on our
    // side fetching data (that needs its own retry/alerting, not a
    // redelivered webhook). Adjust this if you want Event Grid's retry
    // behavior instead.
    context.error(`Failed to process notification for ${correlationId}:`, err);
  }

  return { status: 200 };
}

async function handler(request, context) {
  if (request.method === 'OPTIONS') {
    return handleOptionsValidation(request);
  }
  return handleNotification(request, context);
}

app.http('dde-webhook', {
  methods: ['OPTIONS', 'POST'],
  authLevel: 'anonymous',
  route: 'dde-webhook',
  handler,
});

module.exports = { handler, handleOptionsValidation, handleNotification };
